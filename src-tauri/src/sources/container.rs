//! Container-level probing of remote VOD files.
//!
//! Why this exists: standard Xtream `get_vod_info` only reports a single
//! default audio stream and no subtitles. Real IPTV VOD files — especially
//! the Remux/WEB-DL releases providers ship — carry multiple audio tracks
//! (English + original language + commentary) and several subtitle tracks.
//! To see them we have to demux the container ourselves.
//!
//! Design:
//! - We pull just enough of the remote file to cover the Matroska Segment
//!   header (which contains the Tracks element) or the MP4 `moov` atom.
//! - For Matroska this is almost always in the first few MB — the spec puts
//!   Tracks near the start of the Segment and providers oblige.
//! - For MP4 the `moov` atom can sit at the end of the file ("slow-start"
//!   mode). If we don't see it up front we do a second range-GET targeting
//!   the tail. That's two round-trips at worst, still cheap.
//!
//! No decoding, no demuxing of payloads — just the metadata atoms/elements.
//! Runs entirely off the UI thread (async Rust task via tokio).

use std::io::Cursor;
use std::sync::OnceLock;

use crate::error::Result;
use crate::err;
use crate::sources::xtream::{ProbedTrack, ProbedTracks};

/// Dedicated HTTP client for container probes. The app's shared client has
/// `gzip` enabled, which causes reqwest to intercept *every* response and
/// try to gunzip it — a handful of IPTV CDNs stamp `Content-Encoding: gzip`
/// on byte-range responses containing raw MKV/MP4, and reqwest then errors
/// out with "error decoding response body" before we ever see the bytes.
/// Building a separate client with no compression features avoids the entire
/// decompressor pipeline.
fn probe_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Lumen/0.1 (probe)")
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("probe client")
    })
}

/// Bytes fetched for the initial head probe. 12 MB comfortably covers
/// Matroska files with sizeable front-loaded attachments (fonts for ASS
/// subs push this up fast) plus the SeekHead → Tracks chain, and MP4s
/// with `moov` at the start. If the Tracks element sits past this
/// window we lose subtitle entries that appear after the audio ones —
/// the parser returns what it managed to decode before hitting EOF.
const HEAD_BYTES: u64 = 12 * 1024 * 1024;
/// Tail-fetch size when MP4 `moov` isn't at the front. 2 MB catches most
/// real-world VOD containers short of documentary-scale feature films.
const TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Entry point: probe a remote VOD URL and return its track list. Returns
/// empty (not an error) when the URL's scheme is unsupported, the server
/// refuses range requests, or the container format is unrecognised. The
/// caller decides whether to surface that as "no tracks found" in the UI.
pub async fn probe_url(_client: &reqwest::Client, url: &str) -> Result<ProbedTracks> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(empty());
    }
    // Ignore the caller's client — see `probe_client` doc for why we need a
    // decompression-free one here.
    let client = probe_client();

    // Range-GET the head. A well-behaved server returns 206 Partial Content
    // with Content-Range; some return 200 OK with the full body (in which
    // case we truncate ourselves). Either is fine for our purposes.
    let head = fetch_range(client, url, 0, HEAD_BYTES).await?;

    // Sniff the format by looking at the first few bytes.
    let kind = sniff(&head);
    match kind {
        Some(ContainerKind::Matroska) => probe_matroska(&head).map(|t| t.unwrap_or_else(empty)),
        Some(ContainerKind::Mp4) => {
            // Try head first; if moov wasn't reachable, fetch the tail.
            match probe_mp4_bytes(&head) {
                Ok(Some(t)) => Ok(t),
                _ => {
                    let total = match total_size(client, url).await {
                        Ok(n) if n > HEAD_BYTES => n,
                        _ => return Ok(empty()),
                    };
                    let tail_start = total.saturating_sub(TAIL_BYTES);
                    let tail = fetch_range(client, url, tail_start, TAIL_BYTES).await?;
                    // `mp4` needs a contiguous seekable buffer representing
                    // the full file. Stitch head + padding + tail so that
                    // file offsets in the tail line up with where they'd
                    // actually be. The padding middle is never accessed by
                    // the parser — it only seeks between atom boundaries
                    // listed in the atom tree, and that tree points head
                    // → moov-at-tail directly.
                    let mut buf = Vec::with_capacity(total as usize);
                    buf.extend_from_slice(&head);
                    if tail_start > head.len() as u64 {
                        // Fill the gap with zeros. `mp4` only reads atoms
                        // it's been told about via the atom chain; the gap
                        // sits between mdat and moov and is never visited.
                        let gap = tail_start - head.len() as u64;
                        buf.resize(buf.len() + gap as usize, 0);
                    }
                    buf.extend_from_slice(&tail);
                    probe_mp4_bytes(&buf).map(|t| t.unwrap_or_else(empty))
                }
            }
        }
        None => Ok(empty()),
    }
}

fn empty() -> ProbedTracks {
    ProbedTracks {
        provider: "container".into(),
        ..Default::default()
    }
}

#[derive(Debug, Clone, Copy)]
enum ContainerKind {
    Matroska,
    Mp4,
}

/// Identify the container from its magic bytes. MKV/WebM start with the
/// EBML header `0x1A 0x45 0xDF 0xA3`. MP4 has `ftyp` as the first box,
/// which is the ASCII `ftyp` at offset 4.
fn sniff(bytes: &[u8]) -> Option<ContainerKind> {
    if bytes.len() >= 4 && bytes[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return Some(ContainerKind::Matroska);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some(ContainerKind::Mp4);
    }
    None
}

// ---------- HTTP helpers ----------

async fn fetch_range(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    len: u64,
) -> Result<Vec<u8>> {
    let end = start + len - 1;
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={}-{}", start, end))
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| err!("range send failed ({}..={}): {}", start, end, e))?;
    let status = resp.status();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ce = resp
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !status.is_success() {
        return Err(err!("range fetch failed: {} (ct={}, ce={})", status, ct, ce));
    }
    tracing::debug!(
        target: "lumen_lib",
        "container range {}..={} status={} ct={} ce={}",
        start, end, status, ct, ce
    );
    // Some IPTV CDNs chunk-terminate the connection before sending the full
    // Content-Length worth of bytes, and `.bytes()` reports that as a
    // decode error — even though the partial body we *did* receive is
    // perfectly usable for metadata probing. Stream chunks manually and
    // keep whatever we got when the peer closes early.
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(len as usize);
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(b) => {
                buf.extend_from_slice(&b);
                if buf.len() as u64 >= len {
                    break;
                }
            }
            Err(e) => {
                tracing::debug!(
                    target: "lumen_lib",
                    "range stream cut short at {} bytes (ct={}): {}",
                    buf.len(), ct, e
                );
                // Partial is fine — if we got the EBML/ftyp header plus a
                // few hundred KB we can still find the tracks.
                break;
            }
        }
    }
    let bytes = buf;
    // Truncate defensively if the server ignored our Range header.
    if bytes.len() as u64 > len {
        Ok(bytes[..len as usize].to_vec())
    } else {
        Ok(bytes)
    }
}

/// Resolve total file size via HEAD. Falls back to a zero-length Range
/// trick because some CDNs reject HEAD but honour Range.
async fn total_size(client: &reqwest::Client, url: &str) -> Result<u64> {
    if let Ok(resp) = client.head(url).send().await {
        if let Some(len) = resp.content_length() {
            return Ok(len);
        }
    }
    // Range trick: ask for one byte, read the Content-Range "bytes 0-0/<total>"
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await?;
    if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
        if let Ok(s) = cr.to_str() {
            if let Some(total) = s.rsplit('/').next().and_then(|x| x.parse::<u64>().ok()) {
                return Ok(total);
            }
        }
    }
    Err(err!("could not determine file size"))
}

// ---------- Matroska ----------

fn probe_matroska(bytes: &[u8]) -> Result<Option<ProbedTracks>> {
    let cursor = Cursor::new(bytes);
    let mk = match matroska::Matroska::open(cursor) {
        Ok(m) => m,
        // A partial-read truncation typically manifests here. Not fatal —
        // we just couldn't get far enough into the file for metadata.
        Err(e) => {
            tracing::debug!(target: "lumen_lib", "matroska parse failed: {}", e);
            return Ok(None);
        }
    };

    let mut audio: Vec<ProbedTrack> = Vec::new();
    let mut subtitle: Vec<ProbedTrack> = Vec::new();

    for t in &mk.tracks {
        let is_audio = matches!(t.tracktype, matroska::Tracktype::Audio);
        let is_sub = matches!(t.tracktype, matroska::Tracktype::Subtitle);
        if !is_audio && !is_sub {
            continue;
        }
        let language = t
            .language
            .as_ref()
            .map(|l| match l {
                matroska::Language::ISO639(s) => s.clone(),
                matroska::Language::IETF(s) => s.clone(),
            })
            .filter(|v| !v.is_empty() && v != "und");

        let channel_layout = if is_audio {
            if let matroska::Settings::Audio(ref a) = t.settings {
                match a.channels {
                    1 => Some("Mono".into()),
                    2 => Some("Stereo".into()),
                    6 => Some("5.1".into()),
                    7 => Some("6.1".into()),
                    8 => Some("7.1".into()),
                    n if n > 0 => Some(format!("{}ch", n)),
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };

        let track = ProbedTrack {
            index: t.number as i64,
            codec: Some(mk_codec_short(&t.codec_id).to_string()),
            language,
            title: t.name.clone().filter(|s| !s.is_empty()),
            channel_layout,
            is_default: t.default,
        };

        if is_audio {
            audio.push(track);
        } else {
            subtitle.push(track);
        }
    }

    tracing::info!(
        target: "lumen_lib",
        "matroska probe: {} audio, {} subtitle, {} total tracks parsed",
        audio.len(),
        subtitle.len(),
        mk.tracks.len(),
    );
    for t in &mk.tracks {
        tracing::debug!(
            target: "lumen_lib",
            "  mk track #{} type={:?} codec={} lang={:?}",
            t.number, t.tracktype, t.codec_id, t.language
        );
    }

    Ok(Some(ProbedTracks {
        audio,
        subtitle,
        provider: "container".into(),
    }))
}

/// Matroska `CodecID` strings are verbose ("A_AC3", "A_EAC3", "S_TEXT/UTF8").
/// Compress them to the short name users actually recognise.
fn mk_codec_short(id: &str) -> &str {
    match id {
        "A_AC3" => "AC-3",
        "A_EAC3" => "E-AC-3",
        "A_DTS" => "DTS",
        "A_TRUEHD" => "TrueHD",
        "A_FLAC" => "FLAC",
        "A_OPUS" => "Opus",
        "A_VORBIS" => "Vorbis",
        "A_MPEG/L3" => "MP3",
        "A_MPEG/L2" => "MP2",
        "A_AAC" | "A_AAC/MPEG4/LC" | "A_AAC/MPEG4/LC/SBR" => "AAC",
        "A_PCM/INT/LIT" | "A_PCM/INT/BIG" => "PCM",
        "S_TEXT/UTF8" => "SRT",
        "S_TEXT/ASS" | "S_TEXT/SSA" => "ASS",
        "S_HDMV/PGS" => "PGS",
        "S_VOBSUB" => "VobSub",
        "S_DVBSUB" => "DVB",
        "S_TEXT/WEBVTT" => "WebVTT",
        other => other.trim_start_matches("A_").trim_start_matches("S_"),
    }
}

// ---------- MP4 ----------

fn probe_mp4_bytes(bytes: &[u8]) -> Result<Option<ProbedTracks>> {
    let size = bytes.len() as u64;
    let cursor = Cursor::new(bytes);
    let mp = match mp4::Mp4Reader::read_header(cursor, size) {
        Ok(m) => m,
        Err(e) => {
            // Common case: moov is at the end and we only have the head.
            // Caller falls back to a tail fetch.
            tracing::debug!(target: "lumen_lib", "mp4 parse failed: {}", e);
            return Ok(None);
        }
    };

    let mut audio: Vec<ProbedTrack> = Vec::new();
    let mut subtitle: Vec<ProbedTrack> = Vec::new();

    for (track_id, track) in mp.tracks() {
        let track_type = match track.track_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_audio = matches!(track_type, mp4::TrackType::Audio);
        let is_sub = matches!(track_type, mp4::TrackType::Subtitle);
        if !is_audio && !is_sub {
            continue;
        }
        let language = Some(track.language().to_string())
            .filter(|s| !s.is_empty() && s != "und" && s != "```");

        let codec = track.box_type().ok().map(|b| mp4_codec_short(b.to_string()));

        let channel_layout = if is_audio {
            track.channel_config().ok().and_then(|c| {
                // mp4 crate returns channel config as an enum-ish — use Display or raw count
                let count = c as u32;
                match count {
                    1 => Some("Mono".into()),
                    2 => Some("Stereo".into()),
                    6 => Some("5.1".into()),
                    7 => Some("6.1".into()),
                    8 => Some("7.1".into()),
                    n if n > 0 => Some(format!("{}ch", n)),
                    _ => None,
                }
            })
        } else {
            None
        };

        let t = ProbedTrack {
            index: *track_id as i64,
            codec,
            language,
            title: None, // mp4 `udta` title is file-level, not per-track
            channel_layout,
            is_default: false, // MP4 `tkhd` flags don't map cleanly; leave false
        };

        if is_audio {
            audio.push(t);
        } else {
            subtitle.push(t);
        }
    }

    Ok(Some(ProbedTracks {
        audio,
        subtitle,
        provider: "container".into(),
    }))
}

fn mp4_codec_short(box_name: String) -> String {
    match box_name.as_str() {
        "mp4a" => "AAC".into(),
        "ac-3" | "ac3 " => "AC-3".into(),
        "ec-3" => "E-AC-3".into(),
        "Opus" | "opus" => "Opus".into(),
        "avc1" => "H.264".into(),
        "hev1" | "hvc1" => "HEVC".into(),
        "tx3g" => "TX3G".into(),
        "stpp" => "TTML".into(),
        "wvtt" => "WebVTT".into(),
        _ => box_name,
    }
}

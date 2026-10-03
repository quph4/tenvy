use std::io::{BufReader, Read};

use flate2::read::GzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::err;
use crate::error::Result;
use crate::models::Programme;

/// A parsed XMLTV document.
pub struct Guide {
    pub programmes: Vec<Programme>,
    /// `(channel id, display name)` pairs from `<channel>` elements, used to
    /// match playlist channels that lack a `tvg-id` (see `channel_name_key`).
    pub channel_names: Vec<(String, String)>,
}

/// Parse an XMLTV document. Supports plain `.xml` and gzipped `.xml.gz`
/// (detected by magic bytes). Events are read with a streaming parser, so
/// only the decompressed bytes and the results are held in memory.
///
/// Channel ids are lowercased: playlists and guides routinely disagree on
/// case (`SVT1.se` vs `svt1.se`), and ids are matched case-insensitively.
pub fn parse(bytes: &[u8]) -> Result<Guide> {
    let owned: Vec<u8>;
    let xml: &[u8] = if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut buf = Vec::with_capacity(bytes.len() * 4);
        GzDecoder::new(BufReader::new(bytes)).read_to_end(&mut buf)?;
        owned = buf;
        &owned
    } else {
        bytes
    };

    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut programmes: Vec<Programme> = Vec::new();
    let mut channel_names: Vec<(String, String)> = Vec::new();

    let mut current: Option<Programme> = None;
    let mut current_channel: Option<String> = None;
    let mut in_title = false;
    let mut in_desc = false;
    let mut in_display_name = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match e.name().as_ref() {
                b"programme" => {
                    let mut start: Option<i64> = None;
                    let mut stop: Option<i64> = None;
                    let mut channel: Option<String> = None;
                    for attr in e.attributes().flatten() {
                        let value = attr.decode_and_unescape_value(reader.decoder())?;
                        match attr.key.as_ref() {
                            b"start" => start = parse_xmltv_time(&value),
                            b"stop" => stop = parse_xmltv_time(&value),
                            b"channel" => channel = Some(value.to_lowercase()),
                            _ => {}
                        }
                    }
                    current = match (start, stop, channel) {
                        (Some(start), Some(stop), Some(channel)) => Some(Programme {
                            channel_tvg_id: channel,
                            start,
                            stop,
                            title: String::new(),
                            description: None,
                        }),
                        _ => None,
                    };
                }
                b"channel" => {
                    current_channel = e
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == b"id")
                        .map(|a| a.decode_and_unescape_value(reader.decoder()).map(|v| v.to_lowercase()))
                        .transpose()?;
                }
                b"title" => in_title = current.is_some(),
                b"desc" => in_desc = current.is_some(),
                b"display-name" => in_display_name = current_channel.is_some(),
                _ => {}
            },
            Event::Text(t) => {
                let text = t.unescape()?;
                if let Some(ref mut p) = current {
                    if in_title && p.title.is_empty() {
                        p.title = text.into_owned();
                    } else if in_desc && p.description.is_none() {
                        p.description = Some(text.into_owned());
                    }
                } else if in_display_name {
                    if let Some(id) = &current_channel {
                        channel_names.push((id.clone(), text.into_owned()));
                    }
                }
            }
            Event::End(e) => match e.name().as_ref() {
                b"title" => in_title = false,
                b"desc" => in_desc = false,
                b"display-name" => in_display_name = false,
                b"channel" => current_channel = None,
                b"programme" => {
                    if let Some(p) = current.take() {
                        if !p.title.is_empty() {
                            programmes.push(p);
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if programmes.is_empty() {
        return Err(err!("No programmes parsed from XMLTV"));
    }
    Ok(Guide { programmes, channel_names })
}

/// Normalised channel name for matching playlist channels to guide
/// channels by name: "SE: SVT1 HD", "SVT1 FHD SE" and "SVT1" all become
/// `svt1`. Drops a short `XX:` / `XX |` prefix, then trailing quality tags
/// and two-letter country codes, then everything but letters and digits.
/// Timeshift variants like "SVT1 HD SE [-2H]" keep their suffix and so
/// (correctly) don't match the live channel's guide.
pub fn channel_name_key(name: &str) -> String {
    const QUALITY: &[&str] = &[
        "hd", "fhd", "uhd", "sd", "4k", "8k", "hevc", "h265", "h264", "1080p", "1080", "720p",
        "720", "50fps", "60fps", "raw", "backup", "hq", "lq",
    ];
    let mut s = name.trim();
    // Prefix like "SE:" or "UK |" (2–3 letters followed by ':' or '|').
    if let Some(i) = s.find(&[':', '|'][..]) {
        let head = s[..i].trim();
        if (2..=3).contains(&head.len()) && head.chars().all(|c| c.is_ascii_alphabetic()) {
            s = &s[i + 1..];
        }
    }
    let lower = s.to_lowercase();
    let mut tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    while tokens.len() > 1 {
        let last = tokens[tokens.len() - 1];
        let is_country = last.len() == 2 && last.chars().all(|c| c.is_ascii_alphabetic());
        if QUALITY.contains(&last) || is_country {
            tokens.pop();
        } else {
            break;
        }
    }
    tokens.concat()
}

/// XMLTV timestamps look like `20260416201500 +0000`. Missing timezone is treated as UTC.
fn parse_xmltv_time(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (date_part, tz_part) = match s.find(' ') {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    if date_part.len() < 14 {
        return None;
    }
    // `get`, not indexing: a stray multi-byte character must not panic
    // (release builds abort on panic).
    let naive = chrono::NaiveDateTime::parse_from_str(date_part.get(..14)?, "%Y%m%d%H%M%S").ok()?;
    let offset_sec = tz_part
        .and_then(|tz| {
            let sign = match tz.chars().next()? {
                '+' => 1,
                '-' => -1,
                _ => return None,
            };
            let rest = &tz[1..];
            if rest.len() < 4 {
                return None;
            }
            let hh: i64 = rest.get(0..2)?.parse().ok()?;
            let mm: i64 = rest.get(2..4)?.parse().ok()?;
            Some(sign * (hh * 3600 + mm * 60))
        })
        .unwrap_or(0);
    Some(naive.and_utc().timestamp() - offset_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(
            parse_xmltv_time("20260101120000 +0000"),
            Some(
                chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                    .unwrap()
                    .and_hms_opt(12, 0, 0)
                    .unwrap()
                    .and_utc()
                    .timestamp()
            )
        );
        assert_eq!(parse_xmltv_time("2026010112000é +0000"), None);
        assert_eq!(
            parse_xmltv_time("20260101120000 +0100"),
            parse_xmltv_time("20260101110000 +0000")
        );
    }

    #[test]
    fn parses_programmes_and_channel_names() {
        let xml = br#"<?xml version="1.0"?>
            <tv>
              <channel id="SVT1.se"><display-name>SVT1</display-name><display-name>SVT 1 HD</display-name></channel>
              <programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="SVT1.se">
                <title>Rapport</title><desc>News &amp; weather</desc>
              </programme>
            </tv>"#;
        let g = parse(xml).unwrap();
        assert_eq!(g.programmes.len(), 1);
        assert_eq!(g.programmes[0].channel_tvg_id, "svt1.se");
        assert_eq!(g.programmes[0].description.as_deref(), Some("News & weather"));
        assert_eq!(
            g.channel_names,
            vec![("svt1.se".into(), "SVT1".into()), ("svt1.se".into(), "SVT 1 HD".into())]
        );
    }

    #[test]
    fn name_keys_match_common_variants() {
        for n in ["SVT1", "SVT1 HD", "SVT1 FHD SE", "SE: SVT1 HD", "SE | SVT1"] {
            assert_eq!(channel_name_key(n), "svt1", "{n}");
        }
        assert_eq!(channel_name_key("Eurosport 1 HD SE"), "eurosport1");
        assert_eq!(channel_name_key("TV 4"), "tv4");
        assert_ne!(channel_name_key("SVT1 HD SE [-2H]"), "svt1");
        assert_eq!(channel_name_key("SVT1 Skåne SE"), "svt1skåne");
    }
}

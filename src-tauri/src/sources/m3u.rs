use crate::db::ChannelInsert;
use crate::error::Result;

/// Parse an M3U / M3U8 playlist.
///
/// Tolerant of messy real-world files: ignores blank lines, comments other than
/// `#EXTINF`, and lines without a following URL. Extracts `tvg-id`, `tvg-name`,
/// `tvg-logo`, and `group-title` attributes when present.
pub fn parse(input: &str) -> Result<Vec<ChannelInsert>> {
    let mut out = Vec::new();
    let mut pending: Option<PartialEntry> = None;

    for raw in input.lines() {
        let line = raw.trim_start_matches('\u{FEFF}').trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending = Some(parse_extinf(rest));
            continue;
        }
        if line.starts_with('#') {
            // Ignore other directives (EXTVLCOPT, PLAYLIST, etc.)
            continue;
        }
        // Non-comment line — treat as a URL.
        let stream_url = line.to_string();
        let entry = pending.take().unwrap_or_default();
        let kind = detect_kind(&stream_url).to_string();
        out.push(ChannelInsert {
            tvg_id: entry.tvg_id,
            name: if entry.name.is_empty() {
                stream_url.clone()
            } else {
                entry.name
            },
            logo: entry.logo,
            group: entry.group,
            stream_url,
            kind,
        });
    }

    Ok(out)
}

#[derive(Default)]
struct PartialEntry {
    tvg_id: Option<String>,
    name: String,
    logo: Option<String>,
    group: Option<String>,
}

/// Parse the body of `#EXTINF:<duration>[ attr="val" ...],<name>`.
fn parse_extinf(body: &str) -> PartialEntry {
    // Split into "<duration + attrs>" and "<display name>" at the last comma
    // BEFORE any unquoted character. Attributes always contain `="..."` so
    // commas inside attribute values shouldn't happen in well-formed files;
    // we simply split at the first comma that isn't inside quotes.
    let (attrs_part, name) = split_unquoted_comma(body);

    let mut entry = PartialEntry {
        name: clean(name),
        ..Default::default()
    };

    // Skip leading duration (e.g. "-1 ")
    let attrs_str = attrs_part.trim_start();
    let attrs_str = match attrs_str.find(|c: char| c == ' ' || c == '\t') {
        Some(i) => &attrs_str[i..],
        None => "",
    };

    for (key, value) in iter_attrs(attrs_str) {
        match key {
            "tvg-id" => entry.tvg_id = non_empty(value),
            "tvg-name" if entry.name.is_empty() => entry.name = clean(value),
            "tvg-logo" => entry.logo = non_empty(value),
            "group-title" => entry.group = non_empty(value),
            _ => {}
        }
    }

    entry
}

/// Classify an M3U stream URL as `live`, `movie`, or `series`.
///
/// Xtream-formatted M3U bundles mix live TV with VOD and series. The URL
/// segment is the most reliable signal:
///   http://host/live/USER/PASS/12345.m3u8      → live
///   http://host/movie/USER/PASS/12345.mkv      → movie
///   http://host/series/USER/PASS/12345.mp4     → series
/// For non-Xtream playlists where the path gives us nothing, fall back to
/// the file extension (video containers → movie). Anything else defaults
/// to live — matching the overwhelming common case and keeping older
/// single-kind playlists behaving exactly as before.
pub fn detect_kind(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if path.contains("/series/") {
        return "series";
    }
    if path.contains("/movie/") || path.contains("/movies/") || path.contains("/vod/") {
        return "movie";
    }
    if path.contains("/live/") {
        return "live";
    }
    if path.ends_with(".mp4")
        || path.ends_with(".mkv")
        || path.ends_with(".avi")
        || path.ends_with(".mov")
        || path.ends_with(".m4v")
    {
        return "movie";
    }
    "live"
}

/// Return the scrubbed attribute value, or `None` if it's all whitespace.
///
/// Providers routinely pad `group-title=" Sweden "` with surrounding
/// whitespace (sometimes deliberately, as a sort hack to pin a group to
/// the top of an alphabetical list). We used to preserve that padding
/// verbatim, which made group names render with weird indentation in the
/// sidebar.
///
/// Plain `str::trim` isn't enough — `is_whitespace` follows the Unicode
/// White_Space property, which excludes the zero-width characters that
/// providers sometimes abuse for the same purpose (U+200B, U+FEFF, etc.).
/// `clean` strips both classes from the ends.
pub(crate) fn non_empty(s: &str) -> Option<String> {
    let t = clean(s);
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Trim whitespace *and* invisible formatting characters from both ends,
/// then return the result as an owned String. Used at every ingest point
/// that touches user-visible text (group names, channel names, logos).
pub(crate) fn clean(s: &str) -> String {
    fn is_invisible(c: char) -> bool {
        c.is_whitespace()
            // Zero-width noise that White_Space misses.
            || c == '\u{200B}'   // ZERO WIDTH SPACE
            || c == '\u{200C}'   // ZWNJ
            || c == '\u{200D}'   // ZWJ
            || c == '\u{FEFF}'   // ZERO WIDTH NO-BREAK SPACE / BOM
            || c == '\u{2060}'   // WORD JOINER
            // C0/C1 control characters — shouldn't appear in display text.
            || (c.is_control() && c != '\n' && c != '\t')
    }
    s.trim_matches(is_invisible).to_string()
}

fn split_unquoted_comma(s: &str) -> (&str, &str) {
    let mut in_quote = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ',' if !in_quote => return (&s[..i], &s[i + 1..]),
            _ => {}
        }
    }
    (s, "")
}

/// Yields `(key, value)` pairs from `key="value" key2="value2" …`.
fn iter_attrs(s: &str) -> impl Iterator<Item = (&str, &str)> {
    AttrIter { rest: s }
}

struct AttrIter<'a> {
    rest: &'a str,
}

impl<'a> Iterator for AttrIter<'a> {
    type Item = (&'a str, &'a str);
    fn next(&mut self) -> Option<Self::Item> {
        // Skip whitespace
        let s = self.rest.trim_start();
        if s.is_empty() {
            self.rest = s;
            return None;
        }
        let eq = s.find('=')?;
        let key = s[..eq].trim();
        let after = &s[eq + 1..];
        if !after.starts_with('"') {
            self.rest = "";
            return None;
        }
        let after = &after[1..];
        let end = after.find('"')?;
        let value = &after[..end];
        self.rest = &after[end + 1..];
        Some((key, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic() {
        let src = "#EXTM3U\n\
                   #EXTINF:-1 tvg-id=\"bbc1.uk\" tvg-logo=\"http://l/o.png\" group-title=\"UK\",BBC One HD\n\
                   http://example.com/bbc1\n\
                   #EXTINF:-1,Plain Channel\n\
                   http://example.com/plain\n";
        let out = parse(src).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "BBC One HD");
        assert_eq!(out[0].tvg_id.as_deref(), Some("bbc1.uk"));
        assert_eq!(out[0].group.as_deref(), Some("UK"));
        assert_eq!(out[0].kind, "live");
        assert_eq!(out[1].name, "Plain Channel");
        assert!(out[1].group.is_none());
    }

    #[test]
    fn tolerates_blank_and_unknown_tags() {
        let src = "#EXTM3U\n\n#EXTVLCOPT:foo=1\n#EXTINF:-1,Test\nhttp://x\n";
        let out = parse(src).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Test");
    }

    #[test]
    fn classifies_xtream_url_paths() {
        assert_eq!(detect_kind("http://h/live/u/p/42.m3u8"), "live");
        assert_eq!(detect_kind("http://h/movie/u/p/42.mkv"), "movie");
        assert_eq!(detect_kind("http://h/series/u/p/42.mp4"), "series");
        assert_eq!(detect_kind("http://h/u/p/42"), "live"); // extensionless → live
        assert_eq!(detect_kind("http://h/vod/Avatar.2009.mp4"), "movie");
        assert_eq!(detect_kind("http://h/files/clip.avi"), "movie");
    }
}

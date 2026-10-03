use std::io::{BufReader, Read};

use flate2::read::GzDecoder;
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::Result;
use crate::models::Programme;
use crate::err;

/// Parse an XMLTV document. Supports plain `.xml` and gzipped `.xml.gz`
/// (detected by magic bytes). Uses a streaming SAX-style parser so the entire
/// file doesn't need to fit in memory.
pub fn parse(bytes: &[u8]) -> Result<Vec<Programme>> {
    let mut owned: Vec<u8>;
    let xml: &[u8] = if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        owned = Vec::with_capacity(bytes.len() * 4);
        let mut gz = GzDecoder::new(BufReader::new(bytes));
        gz.read_to_end(&mut owned)?;
        &owned
    } else {
        bytes
    };

    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut out: Vec<Programme> = Vec::new();

    let mut current: Option<PartialProg> = None;
    let mut in_title = false;
    let mut in_desc = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) | Event::Empty(e) => {
                let name = e.name();
                match name.as_ref() {
                    b"programme" => {
                        let mut start: Option<i64> = None;
                        let mut stop: Option<i64> = None;
                        let mut channel: Option<String> = None;
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"start" => {
                                    start = parse_xmltv_time(
                                        &attr.decode_and_unescape_value(reader.decoder())?,
                                    );
                                }
                                b"stop" => {
                                    stop = parse_xmltv_time(
                                        &attr.decode_and_unescape_value(reader.decoder())?,
                                    );
                                }
                                b"channel" => {
                                    channel = Some(
                                        attr.decode_and_unescape_value(reader.decoder())?.into_owned(),
                                    );
                                }
                                _ => {}
                            }
                        }
                        if let (Some(start), Some(stop), Some(channel)) = (start, stop, channel) {
                            current = Some(PartialProg {
                                channel_tvg_id: channel,
                                start,
                                stop,
                                title: String::new(),
                                description: None,
                            });
                        }
                    }
                    b"title" => in_title = current.is_some(),
                    b"desc" => in_desc = current.is_some(),
                    _ => {}
                }
            }
            Event::Text(t) => {
                if let Some(ref mut p) = current {
                    let decoded = t.unescape()?;
                    if in_title && p.title.is_empty() {
                        p.title = decoded.into_owned();
                    } else if in_desc && p.description.is_none() {
                        p.description = Some(decoded.into_owned());
                    }
                }
            }
            Event::End(e) => match e.name().as_ref() {
                b"title" => in_title = false,
                b"desc" => in_desc = false,
                b"programme" => {
                    if let Some(p) = current.take() {
                        if !p.title.is_empty() {
                            out.push(Programme {
                                channel_tvg_id: p.channel_tvg_id,
                                start: p.start,
                                stop: p.stop,
                                title: p.title,
                                description: p.description,
                            });
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

    if out.is_empty() {
        return Err(err!("No programmes parsed from XMLTV"));
    }
    Ok(out)
}

struct PartialProg {
    channel_tvg_id: String,
    start: i64,
    stop: i64,
    title: String,
    description: Option<String>,
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
    let naive = chrono::NaiveDateTime::parse_from_str(&date_part[..14], "%Y%m%d%H%M%S").ok()?;
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
    }
}

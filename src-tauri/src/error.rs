use serde::Serialize;

/// Single error type for everything that crosses the Tauri boundary.
/// Implements `Serialize` so it reaches the frontend as a readable string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Xml(#[from] quick_xml::Error),
    #[error(transparent)]
    XmlAttr(#[from] quick_xml::events::attributes::AttrError),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error(transparent)]
    SerdeJson(#[from] serde_json::Error),
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[macro_export]
macro_rules! err {
    ($($arg:tt)*) => { $crate::error::Error::Msg(format!($($arg)*)) };
}

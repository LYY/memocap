use std::fmt;

#[derive(Debug)]
pub enum ActivityError {
    Busy,
    Corrupt(String),
    UnknownSchema,
    UnsupportedVersion { major: i64, minor: i64 },
    InvalidInput(String),
    Conflict,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Serialization(serde_json::Error),
}

impl fmt::Display for ActivityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => write!(formatter, "activity database is busy or locked"),
            Self::Corrupt(reason) => write!(formatter, "corrupt activity database: {reason}"),
            Self::UnknownSchema => write!(
                formatter,
                "unrecognized activity schema; database was not reset"
            ),
            Self::UnsupportedVersion { major, minor } => {
                write!(formatter, "unsupported activity schema {major}.{minor}")
            }
            Self::InvalidInput(reason) => write!(formatter, "invalid activity metadata: {reason}"),
            Self::Conflict => write!(
                formatter,
                "activity operation/phase already has different metadata"
            ),
            Self::Io(error) => write!(formatter, "activity file: {error}"),
            Self::Sqlite(error) => write!(formatter, "activity SQLite: {error}"),
            Self::Serialization(error) => write!(formatter, "activity serialization: {error}"),
        }
    }
}

impl std::error::Error for ActivityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            Self::Serialization(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for ActivityError {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                Self::Busy
            }
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
                Self::Corrupt(error.to_string())
            }
            _ => Self::Sqlite(error),
        }
    }
}

impl From<std::io::Error> for ActivityError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ActivityError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error)
    }
}

use serde::Serialize;
use specta::{Type, Types, datatype::DataType};

/// Every command's error. The frontend receives it as a message string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("not supported on this platform")]
    Unsupported,
    #[error("background worker stopped")]
    WorkerGone,
    /// A feature-specific failure, already worded for the user.
    #[error("{0}")]
    Message(String),
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl Type for Error {
    fn definition(types: &mut Types) -> DataType {
        String::definition(types)
    }
}

pub type Res<T> = Result<T, Error>;

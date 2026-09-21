use crate::{
    scope::{PlacementId, RepositoryId},
    store::{InventoryMemory, VisibleStackStatus},
};
use serde::Deserialize;

mod client;
mod domains;
mod recovery;

pub use client::{forget, list, recall, remember, status};
pub use domains::{attach_domain, create_domain, delete_domain, detach_domain, domains};
pub use recovery::{copy_move, operation_status, OperationStatus, RecoveryHandle};

pub struct RememberRequest<'a> {
    pub repository: &'a RepositoryId,
    pub placement: &'a PlacementId,
    pub content: &'a str,
    pub kind: &'a str,
    pub tags: &'a str,
    pub topic_key: Option<&'a str>,
    pub force: bool,
    pub overwrite_id: Option<i64>,
}

pub struct RecallRequest<'a> {
    pub repository: &'a RepositoryId,
    pub placement: Option<&'a PlacementId>,
    pub query: &'a str,
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub max_chars: Option<usize>,
}

pub struct RemoteStatus {
    pub domains: Vec<crate::scope::DomainId>,
    pub status: VisibleStackStatus,
}

#[derive(Debug)]
pub(super) enum RequestError {
    Http { status: u16, body: String },
    Transport(Box<ureq::Error>),
    Read(std::io::Error),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http { status: 401, .. } => formatter.write_str("unauthorized: token rejected"),
            Self::Http { status, body } => {
                write!(formatter, "remote request failed ({status}): {body}")
            }
            Self::Transport(error) => error.fmt(formatter),
            Self::Read(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RequestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http { .. } => None,
            Self::Transport(error) => Some(error),
            Self::Read(error) => Some(error),
        }
    }
}

impl RequestError {
    pub(super) const fn is_ambiguous(&self) -> bool {
        matches!(
            self,
            Self::Transport(_) | Self::Read(_) | Self::Http { status: 500.., .. }
        )
    }
}

pub(super) fn post<T: serde::Serialize>(
    address: &str,
    token: &str,
    path: &str,
    body: &T,
) -> std::result::Result<String, RequestError> {
    let address = address.trim().trim_end_matches('/');
    let request =
        ureq::post(&format!("{address}{path}")).set("Authorization", &format!("Bearer {token}"));
    match request.send_json(body) {
        Ok(response) => response.into_string().map_err(RequestError::Read),
        Err(ureq::Error::Status(status, response)) => Err(RequestError::Http {
            status,
            body: response.into_string().unwrap_or_default(),
        }),
        Err(error) => Err(RequestError::Transport(Box::new(error))),
    }
}

pub(super) fn decode<T: serde::de::DeserializeOwned>(
    response: String,
    context: &'static str,
) -> anyhow::Result<T> {
    serde_json::from_str(&response).map_err(|error| anyhow::anyhow!("{context}: {error}"))
}

pub(super) fn into_anyhow(error: RequestError) -> anyhow::Error {
    anyhow::Error::new(error)
}

#[derive(Deserialize)]
pub(super) struct MemoriesReply {
    pub memories: Vec<InventoryMemory>,
}

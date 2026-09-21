use serde::Deserialize;

use crate::scope::{PlacementId, RepositoryId};

use super::Incoming;

mod domains;
mod transfers;

pub use domains::Domain;
pub use transfers::{OperationStatus, Transfer};

pub enum Request {
    Remember(Remember),
    Recall(Recall),
    List(List),
    Forget(Forget),
    Domain(Domain),
    Transfer(Transfer),
    OperationStatus(OperationStatus),
    Status { repository: RepositoryId },
}

pub struct Remember {
    pub repository: RepositoryId,
    pub placement: PlacementId,
    pub content: String,
    pub kind: String,
    pub tags: String,
    pub topic_key: Option<String>,
    pub force: bool,
    pub overwrite_id: Option<i64>,
}

pub struct Recall {
    pub repository: RepositoryId,
    pub placement: Option<PlacementId>,
    pub query: String,
    pub limit: usize,
    pub kind: Option<String>,
    pub max_chars: Option<usize>,
}

pub struct List {
    pub repository: RepositoryId,
    pub placement: Option<PlacementId>,
    pub limit: usize,
}

pub struct Forget {
    pub repository: RepositoryId,
    pub placement: PlacementId,
    pub id: i64,
}

pub enum ParseError {
    NotFound,
    Invalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RememberIn {
    repository: String,
    placement: String,
    content: String,
    #[serde(rename = "type")]
    kind: String,
    tags: String,
    force: bool,
    id: Option<i64>,
    topic_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecallIn {
    repository: String,
    placement: Option<String>,
    query: String,
    limit: usize,
    #[serde(rename = "type")]
    kind: Option<String>,
    max_chars: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListIn {
    repository: String,
    placement: Option<String>,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForgetIn {
    repository: String,
    placement: String,
    id: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusIn {
    repository: String,
}

pub fn parse(incoming: &Incoming) -> Result<Request, ParseError> {
    if incoming.method != "POST" {
        return Err(ParseError::NotFound);
    }
    match incoming.path.as_str() {
        "/v1/memories/remember" => remember(&incoming.body).map(Request::Remember),
        "/v1/memories/recall" => recall(&incoming.body).map(Request::Recall),
        "/v1/memories/list" => list(&incoming.body).map(Request::List),
        "/v1/memories/forget" => forget(&incoming.body).map(Request::Forget),
        "/v1/domains/create" => domains::create(&incoming.body).map(Request::Domain),
        "/v1/domains/list" => domains::list(&incoming.body).map(Request::Domain),
        "/v1/domains/attach" => domains::attach(&incoming.body).map(Request::Domain),
        "/v1/domains/detach" => domains::detach(&incoming.body).map(Request::Domain),
        "/v1/domains/delete" => domains::delete(&incoming.body).map(Request::Domain),
        "/v1/memories/copy" => transfers::copy(&incoming.body).map(Request::Transfer),
        "/v1/memories/move" => transfers::move_memory(&incoming.body).map(Request::Transfer),
        "/v1/operations/status" => {
            transfers::operation_status(&incoming.body).map(Request::OperationStatus)
        }
        "/v1/status" => status(&incoming.body),
        _ => Err(ParseError::NotFound),
    }
}

fn remember(body: &str) -> Result<Remember, ParseError> {
    let input = serde_json::from_str::<RememberIn>(body).map_err(|_| ParseError::Invalid)?;
    let repository = input
        .repository
        .parse::<RepositoryId>()
        .map_err(|_| ParseError::Invalid)?;
    let placement = input
        .placement
        .parse::<PlacementId>()
        .map_err(|_| ParseError::Invalid)?;
    if matches!(&placement, PlacementId::Repository(value) if value != &repository) {
        return Err(ParseError::Invalid);
    }
    Ok(Remember {
        repository,
        placement,
        content: input.content,
        kind: input.kind,
        tags: input.tags,
        topic_key: input.topic_key,
        force: input.force,
        overwrite_id: input.id,
    })
}

fn recall(body: &str) -> Result<Recall, ParseError> {
    let input = serde_json::from_str::<RecallIn>(body).map_err(|_| ParseError::Invalid)?;
    let repository = repository(&input.repository)?;
    Ok(Recall {
        placement: placement(input.placement.as_deref(), &repository)?,
        repository,
        query: input.query,
        limit: input.limit,
        kind: input.kind,
        max_chars: input.max_chars,
    })
}

fn list(body: &str) -> Result<List, ParseError> {
    let input = serde_json::from_str::<ListIn>(body).map_err(|_| ParseError::Invalid)?;
    let repository = repository(&input.repository)?;
    Ok(List {
        placement: placement(input.placement.as_deref(), &repository)?,
        repository,
        limit: input.limit,
    })
}

fn forget(body: &str) -> Result<Forget, ParseError> {
    let input = serde_json::from_str::<ForgetIn>(body).map_err(|_| ParseError::Invalid)?;
    let repository = repository(&input.repository)?;
    let placement = placement(Some(&input.placement), &repository)?.ok_or(ParseError::Invalid)?;
    Ok(Forget {
        repository,
        placement,
        id: input.id,
    })
}

fn status(body: &str) -> Result<Request, ParseError> {
    let input = serde_json::from_str::<StatusIn>(body).map_err(|_| ParseError::Invalid)?;
    Ok(Request::Status {
        repository: repository(&input.repository)?,
    })
}

fn repository(value: &str) -> Result<RepositoryId, ParseError> {
    value.parse().map_err(|_| ParseError::Invalid)
}

fn placement(
    value: Option<&str>,
    repository: &RepositoryId,
) -> Result<Option<PlacementId>, ParseError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let placement = value.parse().map_err(|_| ParseError::Invalid)?;
    if matches!(&placement, PlacementId::Repository(value) if value != repository) {
        return Err(ParseError::Invalid);
    }
    Ok(Some(placement))
}

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    scope::{PlacementId, RepositoryId},
    store::{InventoryMemory, SimilarMemories},
};

use super::{
    decode, into_anyhow, post, MemoriesReply, RecallRequest, RememberRequest, RemoteStatus,
};

#[derive(Serialize)]
struct RememberBody<'a> {
    repository: &'a str,
    placement: String,
    content: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    tags: &'a str,
    topic_key: Option<&'a str>,
    force: bool,
    id: Option<i64>,
}

#[derive(Serialize)]
struct RecallBody<'a> {
    repository: &'a str,
    placement: Option<String>,
    query: &'a str,
    limit: usize,
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    max_chars: Option<usize>,
}

#[derive(Serialize)]
struct ListBody<'a> {
    repository: &'a str,
    placement: Option<String>,
    limit: usize,
}

#[derive(Serialize)]
struct ForgetBody<'a> {
    repository: &'a str,
    placement: String,
    id: i64,
}

#[derive(Serialize)]
struct StatusBody<'a> {
    repository: &'a str,
}

#[derive(Deserialize)]
struct IdReply {
    id: i64,
}

#[derive(Deserialize)]
struct ForgetReply {
    deleted: bool,
}

#[derive(Deserialize)]
struct SimilarReply {
    candidates: Vec<crate::store::Memory>,
}

#[derive(Deserialize)]
struct StatusReply {
    domains: Vec<String>,
    status: crate::store::VisibleStackStatus,
}

pub fn remember(address: &str, token: &str, request: RememberRequest<'_>) -> Result<i64> {
    let body = RememberBody {
        repository: request.repository.as_str(),
        placement: request.placement.to_string(),
        content: request.content,
        kind: request.kind,
        tags: request.tags,
        topic_key: request.topic_key,
        force: request.force,
        id: request.overwrite_id,
    };
    match post(address, token, "/v1/memories/remember", &body) {
        Ok(response) => Ok(decode::<IdReply>(response, "remember reply")?.id),
        Err(super::RequestError::Http { status: 409, body }) => {
            let reply = decode::<SimilarReply>(body, "similar reply")?;
            Err(SimilarMemories {
                candidates: reply.candidates,
            }
            .into())
        }
        Err(error) => Err(into_anyhow(error)),
    }
}

pub fn recall(
    address: &str,
    token: &str,
    request: RecallRequest<'_>,
) -> Result<Vec<InventoryMemory>> {
    let body = RecallBody {
        repository: request.repository.as_str(),
        placement: request.placement.map(ToString::to_string),
        query: request.query,
        limit: request.limit,
        kind: request.kind,
        max_chars: request.max_chars,
    };
    let response = post(address, token, "/v1/memories/recall", &body).map_err(into_anyhow)?;
    Ok(decode::<MemoriesReply>(response, "recall reply")?.memories)
}

pub fn list(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    placement: Option<&PlacementId>,
    limit: usize,
) -> Result<Vec<InventoryMemory>> {
    let body = ListBody {
        repository: repository.as_str(),
        placement: placement.map(ToString::to_string),
        limit,
    };
    let response = post(address, token, "/v1/memories/list", &body).map_err(into_anyhow)?;
    Ok(decode::<MemoriesReply>(response, "list reply")?.memories)
}

pub fn forget(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    placement: &PlacementId,
    id: i64,
) -> Result<bool> {
    let body = ForgetBody {
        repository: repository.as_str(),
        placement: placement.to_string(),
        id,
    };
    let response = post(address, token, "/v1/memories/forget", &body).map_err(into_anyhow)?;
    Ok(decode::<ForgetReply>(response, "forget reply")?.deleted)
}

pub fn status(address: &str, token: &str, repository: &RepositoryId) -> Result<RemoteStatus> {
    let body = StatusBody {
        repository: repository.as_str(),
    };
    let reply = decode::<StatusReply>(
        post(address, token, "/v1/status", &body).map_err(into_anyhow)?,
        "status reply",
    )?;
    let domains = reply
        .domains
        .into_iter()
        .map(|domain| {
            domain
                .parse()
                .map_err(|_| anyhow::anyhow!("status reply contains invalid domain"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RemoteStatus {
        domains,
        status: reply.status,
    })
}

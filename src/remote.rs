use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;

use crate::{scope::ScopeId, store::Memory};

#[derive(Debug, Deserialize)]
struct RememberReply {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct MemoriesReply {
    memories: Vec<Memory>,
}

#[derive(Debug, Deserialize)]
struct ForgetReply {
    deleted: bool,
}

#[derive(Debug, Deserialize)]
struct CountReply {
    count: i64,
}

pub struct RememberRequest<'a> {
    pub scope: &'a ScopeId,
    pub content: &'a str,
    pub kind: &'a str,
    pub tags: &'a str,
    pub topic_key: Option<&'a str>,
    pub force: bool,
    pub overwrite_id: Option<i64>,
}

pub struct RecallRequest<'a> {
    pub scope: &'a ScopeId,
    pub query: &'a str,
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub max_chars: Option<usize>,
}

fn base(address: &str) -> String {
    address.trim().trim_end_matches('/').to_owned()
}

fn send(req: ureq::Request, token: &str, body: Option<serde_json::Value>) -> Result<String> {
    let req = req.set("Authorization", &format!("Bearer {token}"));
    let result = match body {
        Some(value) => req.send_json(value),
        None => req.call(),
    };
    match result {
        Ok(resp) => resp.into_string().context("read body"),
        Err(ureq::Error::Status(401, _)) => bail!("unauthorized: token rejected"),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            bail!("remote request failed ({code}): {text}")
        }
        Err(error) => Err(error.into()),
    }
}

pub fn remember(address: &str, token: &str, memory: RememberRequest<'_>) -> Result<i64> {
    let req = ureq::post(&format!("{}/remember", base(address)))
        .set("Authorization", &format!("Bearer {token}"));
    let mut payload = json!({
        "scope": memory.scope.as_str(),
        "content": memory.content,
        "type": memory.kind,
        "tags": memory.tags,
        "force": memory.force,
        "id": memory.overwrite_id,
    });
    if let Some(topic_key) = memory.topic_key {
        payload["topic_key"] = serde_json::Value::String(topic_key.to_owned());
    }
    match req.send_json(payload) {
        Ok(resp) => {
            let text = resp.into_string().context("read body")?;
            let reply: RememberReply = serde_json::from_str(&text).context("remember reply")?;
            Ok(reply.id)
        }
        Err(ureq::Error::Status(401, _)) => bail!("unauthorized: token rejected"),
        Err(ureq::Error::Status(409, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            #[derive(Deserialize)]
            struct SimilarReply {
                candidates: Vec<Memory>,
            }
            let reply: SimilarReply = serde_json::from_str(&text).context("similar reply")?;
            Err(crate::store::SimilarMemories {
                candidates: reply.candidates,
            }
            .into())
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            bail!("remote request failed ({code}): {text}")
        }
        Err(error) => Err(error.into()),
    }
}

pub fn recall(address: &str, token: &str, recall: RecallRequest<'_>) -> Result<Vec<Memory>> {
    let mut req = ureq::get(&format!("{}/recall", base(address)))
        .query("scope", recall.scope.as_str())
        .query("q", recall.query)
        .query("limit", &recall.limit.to_string());
    if let Some(kind) = recall.kind {
        req = req.query("type", kind);
    }
    if let Some(max_chars) = recall.max_chars {
        req = req.query("max_chars", &max_chars.to_string());
    }
    let text = send(req, token, None)?;
    let reply: MemoriesReply = serde_json::from_str(&text).context("recall reply")?;
    Ok(reply.memories)
}

pub fn list(address: &str, token: &str, scope: &ScopeId, limit: usize) -> Result<Vec<Memory>> {
    let text = send(
        ureq::get(&format!("{}/list", base(address)))
            .query("scope", scope.as_str())
            .query("limit", &limit.to_string()),
        token,
        None,
    )?;
    let reply: MemoriesReply = serde_json::from_str(&text).context("list reply")?;
    Ok(reply.memories)
}

pub fn forget(address: &str, token: &str, scope: &ScopeId, id: i64) -> Result<bool> {
    let text = send(
        ureq::post(&format!("{}/forget", base(address))),
        token,
        Some(json!({"scope": scope.as_str(), "id": id})),
    )?;
    let reply: ForgetReply = serde_json::from_str(&text).context("forget reply")?;
    Ok(reply.deleted)
}

pub fn count(address: &str, token: &str, scope: &ScopeId) -> Result<i64> {
    let text = send(
        ureq::get(&format!("{}/count", base(address))).query("scope", scope.as_str()),
        token,
        None,
    )?;
    let reply: CountReply = serde_json::from_str(&text).context("count reply")?;
    Ok(reply.count)
}

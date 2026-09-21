use std::str::FromStr;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    scope::{OperationId, PlacementId, RepositoryId},
    store::{CopyMoveAction, CopyMoveRequest, CopyMoveResult},
};

use super::{into_anyhow, post, RequestError};

const RECOVERY_PREFIX: &str = "operation-recovery:v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryHandle {
    repository: RepositoryId,
    operation_id: OperationId,
    request_fingerprint: String,
}

impl RecoveryHandle {
    pub fn from_request(request: &CopyMoveRequest) -> Result<Self> {
        let handle = Self {
            repository: request.repository().clone(),
            operation_id: request.operation_id().clone(),
            request_fingerprint: request.request_fingerprint().to_owned(),
        };
        handle.validate()?;
        Ok(handle)
    }

    #[must_use]
    pub fn repository(&self) -> &RepositoryId {
        &self.repository
    }

    #[must_use]
    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    #[must_use]
    pub fn request_fingerprint(&self) -> &str {
        &self.request_fingerprint
    }

    fn validate(&self) -> Result<()> {
        let hash = self
            .repository
            .as_str()
            .strip_prefix("repository:")
            .ok_or_else(|| anyhow::anyhow!("invalid recovery handle"))?;
        if !is_sha256(hash) || !is_sha256(&self.request_fingerprint) {
            anyhow::bail!("invalid recovery handle")
        }
        Ok(())
    }
}

impl std::fmt::Display for RecoveryHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hash = self
            .repository
            .as_str()
            .strip_prefix("repository:")
            .unwrap_or_default();
        write!(
            formatter,
            "{RECOVERY_PREFIX}:{hash}:{}:{}",
            self.operation_id, self.request_fingerprint
        )
    }
}

impl FromStr for RecoveryHandle {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        let mut parts = value.split(':');
        let (Some(kind), Some(version), Some(repository), Some(operation_id), Some(fingerprint)) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            anyhow::bail!("invalid recovery handle")
        };
        if kind != "operation-recovery" || version != "v1" || parts.next().is_some() {
            anyhow::bail!("invalid recovery handle")
        }
        let handle = Self {
            repository: format!("repository:{repository}")
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid recovery handle"))?,
            operation_id: operation_id
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid recovery handle"))?,
            request_fingerprint: fingerprint.to_owned(),
        };
        handle.validate()?;
        Ok(handle)
    }
}

pub enum OperationStatus {
    Committed(CopyMoveResult),
    NotFound,
    Unknown,
}

#[derive(Serialize)]
struct TransferBody<'a> {
    repository: &'a str,
    id: i64,
    from: String,
    to: String,
    operation_id: &'a str,
    note: Option<&'a str>,
}

#[derive(Serialize)]
struct OperationStatusBody<'a> {
    repository: &'a str,
    operation_id: &'a str,
    request_fingerprint: &'a str,
}

#[derive(Deserialize)]
struct TransferEnvelope {
    result: TransferResult,
}

#[derive(Deserialize)]
struct TransferResult {
    action: CopyMoveAction,
    memory_id: i64,
    from: String,
    to: String,
    operation_id: String,
}

#[derive(Deserialize)]
struct OperationReply {
    outcome: String,
    result: Option<TransferResult>,
}

pub fn copy_move(address: &str, token: &str, request: &CopyMoveRequest) -> Result<CopyMoveResult> {
    match send_transfer(address, token, request) {
        Ok(result) => Ok(result),
        Err(error) if error.is_ambiguous() => recover(address, token, request),
        Err(error) => Err(into_anyhow(error)),
    }
}

pub fn operation_status(
    address: &str,
    token: &str,
    handle: &RecoveryHandle,
) -> Result<OperationStatus> {
    let body = OperationStatusBody {
        repository: handle.repository().as_str(),
        operation_id: handle.operation_id().as_str(),
        request_fingerprint: handle.request_fingerprint(),
    };
    let response = match post(address, token, "/v1/operations/status", &body) {
        Ok(response) => response,
        Err(error) if error.is_ambiguous() => return Ok(OperationStatus::Unknown),
        Err(error) => return Err(into_anyhow(error)),
    };
    let reply = serde_json::from_str::<OperationReply>(&response)
        .map_err(|error| anyhow::anyhow!("operation status reply: {error}"))?;
    match (reply.outcome.as_str(), reply.result) {
        ("committed", Some(result)) => Ok(OperationStatus::Committed(result.into_result()?)),
        ("not_found", None) => Ok(OperationStatus::NotFound),
        _ => Err(anyhow::anyhow!("operation status reply is invalid")),
    }
}

fn send_transfer(
    address: &str,
    token: &str,
    request: &CopyMoveRequest,
) -> std::result::Result<CopyMoveResult, RequestError> {
    let path = match request.action() {
        CopyMoveAction::Copy => "/v1/memories/copy",
        CopyMoveAction::Move => "/v1/memories/move",
    };
    let body = TransferBody {
        repository: request.repository().as_str(),
        id: request.memory_id(),
        from: request.from().to_string(),
        to: request.to().to_string(),
        operation_id: request.operation_id().as_str(),
        note: request.applicability_note(),
    };
    let response = post(address, token, path, &body)?;
    let envelope = serde_json::from_str::<TransferEnvelope>(&response)
        .map_err(|error| RequestError::Read(std::io::Error::other(error)))?;
    envelope
        .result
        .into_result()
        .map_err(|error| RequestError::Read(std::io::Error::other(error)))
}

fn recover(address: &str, token: &str, request: &CopyMoveRequest) -> Result<CopyMoveResult> {
    let handle = RecoveryHandle::from_request(request)?;
    match operation_status(address, token, &handle)? {
        OperationStatus::Committed(result) => Ok(result),
        OperationStatus::Unknown => outcome_unknown(handle),
        OperationStatus::NotFound => match send_transfer(address, token, request) {
            Ok(result) => Ok(result),
            Err(error) if error.is_ambiguous() => {
                match operation_status(address, token, &handle)? {
                    OperationStatus::Committed(result) => Ok(result),
                    OperationStatus::NotFound | OperationStatus::Unknown => outcome_unknown(handle),
                }
            }
            Err(error) => Err(into_anyhow(error)),
        },
    }
}

fn outcome_unknown<T>(handle: RecoveryHandle) -> Result<T> {
    Err(anyhow::anyhow!("outcome unknown; recovery: {handle}"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl TransferResult {
    fn into_result(self) -> Result<CopyMoveResult> {
        Ok(CopyMoveResult {
            action: self.action,
            memory_id: self.memory_id,
            from: self
                .from
                .parse::<PlacementId>()
                .map_err(|_| anyhow::anyhow!("transfer reply contains invalid source placement"))?,
            to: self.to.parse::<PlacementId>().map_err(|_| {
                anyhow::anyhow!("transfer reply contains invalid destination placement")
            })?,
            operation_id: self
                .operation_id
                .parse::<OperationId>()
                .map_err(|_| anyhow::anyhow!("transfer reply contains invalid operation ID"))?,
        })
    }
}

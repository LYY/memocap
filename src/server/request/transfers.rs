use serde::Deserialize;

use crate::{
    scope::{OperationId, RepositoryId},
    store::{CopyMoveAction, CopyMoveInput, CopyMoveRequest},
};

use super::{placement, repository, ParseError};

pub struct Transfer {
    pub request: CopyMoveRequest,
}

pub struct OperationStatus {
    pub repository: RepositoryId,
    pub operation_id: OperationId,
    pub request_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferIn {
    repository: String,
    id: i64,
    from: String,
    to: String,
    operation_id: String,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationStatusIn {
    repository: String,
    operation_id: String,
    request_fingerprint: String,
}

pub fn copy(body: &str) -> Result<Transfer, ParseError> {
    transfer(body, CopyMoveAction::Copy)
}

pub fn move_memory(body: &str) -> Result<Transfer, ParseError> {
    transfer(body, CopyMoveAction::Move)
}

pub fn operation_status(body: &str) -> Result<OperationStatus, ParseError> {
    let input = serde_json::from_str::<OperationStatusIn>(body).map_err(|_| ParseError::Invalid)?;
    if !is_sha256(&input.request_fingerprint) {
        return Err(ParseError::Invalid);
    }
    Ok(OperationStatus {
        repository: repository(&input.repository)?,
        operation_id: input
            .operation_id
            .parse()
            .map_err(|_| ParseError::Invalid)?,
        request_fingerprint: input.request_fingerprint,
    })
}

fn transfer(body: &str, action: CopyMoveAction) -> Result<Transfer, ParseError> {
    let input = serde_json::from_str::<TransferIn>(body).map_err(|_| ParseError::Invalid)?;
    let repository = repository(&input.repository)?;
    let from = placement(Some(&input.from), &repository)?.ok_or(ParseError::Invalid)?;
    let to = placement(Some(&input.to), &repository)?.ok_or(ParseError::Invalid)?;
    let operation_id = input
        .operation_id
        .parse()
        .map_err(|_| ParseError::Invalid)?;
    let request = CopyMoveRequest::prepare(
        repository,
        CopyMoveInput {
            action,
            memory_id: input.id,
            from,
            to,
            operation_id: Some(operation_id),
            applicability_note: input.note,
        },
    )
    .map_err(|_| ParseError::Invalid)?;
    Ok(Transfer { request })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

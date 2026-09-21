use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::scope::{OperationId, PlacementId, RepositoryId};

mod operations;

pub use operations::{copy_move, operation_status, replay_copy_move};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyMoveAction {
    Copy,
    Move,
}

impl CopyMoveAction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
        }
    }

    #[must_use]
    pub const fn past_tense(self) -> &'static str {
        match self {
            Self::Copy => "copied",
            Self::Move => "moved",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveInput {
    pub action: CopyMoveAction,
    pub memory_id: i64,
    pub from: PlacementId,
    pub to: PlacementId,
    pub operation_id: Option<OperationId>,
    pub applicability_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveRequest {
    repository: RepositoryId,
    action: CopyMoveAction,
    memory_id: i64,
    from: PlacementId,
    to: PlacementId,
    operation_id: OperationId,
    applicability_note: Option<String>,
    request_fingerprint: RequestFingerprint,
    mutation_json: String,
}

impl CopyMoveRequest {
    pub fn prepare(repository: RepositoryId, input: CopyMoveInput) -> Result<Self> {
        let applicability_note = input
            .applicability_note
            .map(|note| note.trim().to_owned())
            .filter(|note| !note.is_empty());
        let mutation = StoredMutation {
            action: input.action,
            memory_id: input.memory_id,
            from: input.from.to_string(),
            to: input.to.to_string(),
            applicability_note: applicability_note.clone(),
        };
        let mutation_json =
            serde_json::to_string(&mutation).context("serialize copy/move mutation")?;
        let request_fingerprint = RequestFingerprint::new(&repository, &mutation)?;
        let operation_id = input
            .operation_id
            .unwrap_or_else(|| OperationId::from_request_fingerprint(request_fingerprint.as_str()));
        Ok(Self {
            repository,
            action: input.action,
            memory_id: input.memory_id,
            from: input.from,
            to: input.to,
            operation_id,
            applicability_note,
            request_fingerprint,
            mutation_json,
        })
    }

    #[must_use]
    pub fn from(&self) -> &PlacementId {
        &self.from
    }

    #[must_use]
    pub fn to(&self) -> &PlacementId {
        &self.to
    }

    #[must_use]
    pub fn repository(&self) -> &RepositoryId {
        &self.repository
    }

    #[must_use]
    pub const fn action(&self) -> CopyMoveAction {
        self.action
    }

    #[must_use]
    pub const fn memory_id(&self) -> i64 {
        self.memory_id
    }

    #[must_use]
    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }

    #[must_use]
    pub fn applicability_note(&self) -> Option<&str> {
        self.applicability_note.as_deref()
    }

    #[must_use]
    pub fn request_fingerprint(&self) -> &str {
        self.request_fingerprint.as_str()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveResult {
    pub action: CopyMoveAction,
    pub memory_id: i64,
    pub from: PlacementId,
    pub to: PlacementId,
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequestFingerprint(String);

impl RequestFingerprint {
    fn new(repository: &RepositoryId, mutation: &StoredMutation) -> Result<Self> {
        let encoded = serde_json::to_vec(&FingerprintPayload {
            repository_id: repository.as_str(),
            mutation,
        })
        .context("serialize copy/move request fingerprint")?;
        let mut digest = Sha256::new();
        digest.update(encoded);
        Ok(Self(format!("{:x}", digest.finalize())))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Serialize)]
struct FingerprintPayload<'a> {
    repository_id: &'a str,
    mutation: &'a StoredMutation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredMutation {
    action: CopyMoveAction,
    memory_id: i64,
    from: String,
    to: String,
    applicability_note: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredResult {
    action: CopyMoveAction,
    memory_id: i64,
    from: String,
    to: String,
    operation_id: String,
}

impl From<&CopyMoveResult> for StoredResult {
    fn from(result: &CopyMoveResult) -> Self {
        Self {
            action: result.action,
            memory_id: result.memory_id,
            from: result.from.to_string(),
            to: result.to.to_string(),
            operation_id: result.operation_id.to_string(),
        }
    }
}

impl StoredResult {
    fn into_result(self) -> Result<CopyMoveResult> {
        Ok(CopyMoveResult {
            action: self.action,
            memory_id: self.memory_id,
            from: self.from.parse().map_err(|_| {
                anyhow::anyhow!("operation ledger contains invalid source placement")
            })?,
            to: self.to.parse().map_err(|_| {
                anyhow::anyhow!("operation ledger contains invalid destination placement")
            })?,
            operation_id: self
                .operation_id
                .parse()
                .map_err(|_| anyhow::anyhow!("operation ledger contains invalid operation ID"))?,
        })
    }
}

use crate::scope::{OperationId, PlacementId, RepositoryId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityEvent {
    #[serde(with = "super::serde_ids::scalar")]
    pub operation_id: OperationId,
    #[serde(default, with = "crate::receipt::ids::optional")]
    pub related_operation_id: Option<OperationId>,
    pub started_at: String,
    pub elapsed_ms: u64,
    pub context: ActivityContext,
    pub detail: ActivityDetail,
    pub receipt: Option<ReceiptDetails>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredActivity {
    pub event_id: i64,
    pub recorded_at: String,
    #[serde(flatten)]
    pub event: ActivityEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityContext {
    #[serde(with = "super::serde_ids::list")]
    pub repository_ids: Vec<RepositoryId>,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub actor: String,
    pub backend: ActivityBackend,
    pub origin: ActivityOrigin,
}

impl Default for ActivityContext {
    fn default() -> Self {
        Self {
            repository_ids: vec![],
            session_id: None,
            message_id: None,
            actor: "cli".into(),
            backend: ActivityBackend::Local,
            origin: ActivityOrigin::Cli,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityBackend {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityOrigin {
    Cli,
    Plugin,
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    content = "metadata",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ActivityDetail {
    Write(WriteActivity),
    Recall(RecallActivity),
    InjectionPrepared(InjectionActivity),
    InjectionObserved(InjectionActivity),
}

impl ActivityDetail {
    pub(crate) fn phase(&self) -> &'static str {
        match self {
            Self::Write(_) => "write",
            Self::Recall(_) => "recall",
            Self::InjectionPrepared(_) => "injection_prepared",
            Self::InjectionObserved(_) => "injection_observed",
        }
    }

    pub(crate) fn category(&self) -> &'static str {
        match self {
            Self::Write(_) => "write",
            Self::Recall(_) | Self::InjectionPrepared(_) | Self::InjectionObserved(_) => "read",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteActivity {
    pub action: WriteAction,
    pub status: WriteStatus,
    pub memory_ids: Vec<i64>,
    #[serde(with = "super::serde_ids::list")]
    pub placements: Vec<PlacementId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteAction {
    Remember,
    Forget,
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteStatus {
    Inserted,
    Updated,
    Deleted,
    Rejected,
    OutcomeUnknown,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecallActivity {
    pub status: RecallStatus,
    #[serde(with = "super::serde_ids::list")]
    pub searched_placements: Vec<PlacementId>,
    pub query_terms: Vec<String>,
    pub matched_ids: Vec<i64>,
    pub returned_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecallStatus {
    Ok,
    Empty,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InjectionActivity {
    pub status: InjectionStatus,
    pub injected_ids: Vec<i64>,
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectionStatus {
    Ok,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptDetails {
    pub truncated: bool,
    pub result_limit: Option<u32>,
    pub max_chars: Option<u32>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActivityQuery<'a> {
    pub writes_only: bool,
    pub repository: Option<&'a RepositoryId>,
    pub session_id: Option<&'a str>,
    pub operation_id: Option<&'a OperationId>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for ActivityQuery<'_> {
    fn default() -> Self {
        Self {
            writes_only: false,
            repository: None,
            session_id: None,
            operation_id: None,
            limit: 20,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordOutcome {
    Recorded,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "activity_status", rename_all = "snake_case")]
pub enum ActivityStatus {
    Recorded,
    Duplicate,
    Failed { warning: String },
}

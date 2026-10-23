use crate::{activity, scope::OperationId, store};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

pub mod ids;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub canonical_path: Option<PathBuf>,
    #[serde(with = "ids")]
    pub repository_id: crate::scope::RepositoryId,
    pub identity_source: String,
    pub placements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryResult {
    pub memory: store::Memory,
    pub source_order: usize,
    pub visibility: String,
    pub applicable_repositories: Vec<String>,
    pub shadowed_by: Option<store::ShadowCause>,
}

impl MemoryResult {
    pub fn inventory(entry: store::InventoryMemory, repositories: Vec<String>) -> Self {
        let (visibility, shadowed_by) = match entry.visibility {
            store::Visibility::Visible => ("visible", None),
            store::Visibility::Shadowed(cause) => ("shadowed", Some(cause)),
        };
        Self {
            memory: entry.memory,
            source_order: entry.source_order,
            visibility: visibility.into(),
            applicable_repositories: repositories,
            shadowed_by,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainOutcome {
    pub action: crate::operation::DomainAction,
    #[serde(with = "ids::optional")]
    pub domain: Option<crate::scope::DomainId>,
    pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Empty,
    Skipped,
    Failed,
    Inserted,
    Updated,
    Deleted,
    Rejected,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub format_version: u8,
    pub package_version: String,
    pub operation_id: String,
    pub operation: String,
    pub status: Status,
    pub backend: String,
    pub origin: String,
    pub caller: crate::operation::Caller,
    pub started_at: String,
    pub elapsed_ms: u64,
    pub targets: Vec<Target>,
    pub searched_placements: Vec<String>,
    pub query_terms: Vec<String>,
    pub matched_ids: Vec<i64>,
    pub returned_ids: Vec<i64>,
    pub results: Vec<MemoryResult>,
    pub truncated: bool,
    pub error: Option<ReceiptError>,
    pub activity_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory: Option<Vec<crate::inventory::PlacementInventory>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<ActivityRecord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<crate::inspection::Inspection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_operation: Option<DomainOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRecord {
    pub event_id: i64,
    pub recorded_at: String,
    #[serde(flatten)]
    pub event: activity::ActivityEvent,
}

impl From<activity::StoredActivity> for ActivityRecord {
    fn from(stored: activity::StoredActivity) -> Self {
        Self {
            event_id: stored.event_id,
            recorded_at: stored.recorded_at,
            event: stored.event,
        }
    }
}

impl Receipt {
    pub fn new(operation: &str) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let started_at = chrono::Utc::now().to_rfc3339();
        let id = OperationId::from_request_fingerprint(&format!(
            "{started_at}:{}:{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        Self {
            format_version: 1,
            package_version: env!("CARGO_PKG_VERSION").into(),
            operation_id: id.to_string(),
            operation: operation.into(),
            status: Status::Ok,
            backend: "local".into(),
            origin: "cli".into(),
            caller: crate::operation::Caller::default(),
            started_at,
            elapsed_ms: 0,
            targets: vec![],
            searched_placements: vec![],
            query_terms: vec![],
            matched_ids: vec![],
            returned_ids: vec![],
            results: vec![],
            truncated: false,
            error: None,
            activity_status: "not_requested".into(),
            warning: None,
            inventory: None,
            events: None,
            history_status: None,
            inspection: None,
            domains: None,
            domain_operation: None,
            recovery: None,
            outcome: None,
        }
    }

    pub fn finish(&mut self, start: Instant) {
        self.elapsed_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    }

    pub fn fail(&mut self, code: &str, message: String) {
        self.status = Status::Failed;
        self.error = Some(ReceiptError {
            code: code.into(),
            message,
        });
    }

    pub fn activity(&mut self, status: activity::ActivityStatus) {
        match status {
            activity::ActivityStatus::Recorded => self.activity_status = "recorded".into(),
            activity::ActivityStatus::Duplicate => self.activity_status = "duplicate".into(),
            activity::ActivityStatus::Failed { warning } => {
                self.activity_status = "failed".into();
                self.warning = Some(warning);
            }
        }
    }

    pub fn succeeded(&self) -> bool {
        !matches!(
            self.status,
            Status::Failed | Status::Rejected | Status::OutcomeUnknown
        )
    }
}

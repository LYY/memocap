use crate::{
    activity,
    receipt::Target,
    scope::{OperationId, PlacementId, RepositoryId},
    store,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
mod execution;
pub use execution::execute;
mod caller;
mod history;
mod reads;
mod recovery;
mod writes;
pub use caller::Caller;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(with = "crate::receipt::ids")]
    pub operation_id: OperationId,
    pub targets: Vec<Target>,
    pub command: Command,
    #[serde(default)]
    pub caller: Caller,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Remember {
        content: String,
        kind: String,
        tags: String,
        topic: Option<String>,
        force: bool,
        id: Option<i64>,
        #[serde(with = "crate::receipt::ids::optional")]
        placement: Option<PlacementId>,
    },
    Recall {
        query: String,
        match_mode: store::MatchMode,
        limit: usize,
        kind: Option<String>,
        max_chars: Option<usize>,
        #[serde(with = "crate::receipt::ids::optional")]
        placement: Option<PlacementId>,
    },
    List {
        limit: usize,
        offset: usize,
        exact: bool,
        #[serde(with = "crate::receipt::ids::optional")]
        placement: Option<PlacementId>,
    },
    Forget {
        id: i64,
        #[serde(with = "crate::receipt::ids::optional")]
        placement: Option<PlacementId>,
    },
    ScopeShow,
    Inventory,
    Status {
        read_only: bool,
    },
    ActivityList {
        writes: bool,
        limit: u32,
        offset: u32,
        #[serde(with = "crate::receipt::ids::optional")]
        repository: Option<RepositoryId>,
        session: Option<String>,
        #[serde(with = "crate::receipt::ids::optional")]
        filter_operation: Option<OperationId>,
    },
    ActivityShow {
        #[serde(with = "crate::receipt::ids")]
        id: OperationId,
    },
    ActivityRecord {
        event: Box<activity::ActivityEvent>,
    },
    ActivityPrepare,
    OperationStatus {
        recovery: String,
    },
    Transfer {
        action: store::CopyMoveAction,
        id: i64,
        #[serde(with = "crate::receipt::ids")]
        from: PlacementId,
        #[serde(with = "crate::receipt::ids")]
        to: PlacementId,
        #[serde(with = "crate::receipt::ids::optional")]
        idempotency_key: Option<OperationId>,
        note: Option<String>,
    },
    Domain {
        action: DomainAction,
        #[serde(with = "crate::receipt::ids::optional")]
        domain: Option<crate::scope::DomainId>,
        #[serde(with = "crate::receipt::ids::optional")]
        before: Option<crate::scope::DomainId>,
        all: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainAction {
    Create,
    Attach,
    Detach,
    Delete,
    List,
}

impl Command {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Remember { .. } => "remember",
            Self::Recall { .. } => "recall",
            Self::List { .. } => "list",
            Self::Forget { .. } => "forget",
            Self::ScopeShow => "scope_show",
            Self::Inventory => "inventory",
            Self::Status { .. } => "status",
            Self::ActivityList { .. } => "activity_list",
            Self::ActivityShow { .. } => "activity_show",
            Self::ActivityRecord { .. } => "activity_record",
            Self::ActivityPrepare => "activity_prepare",
            Self::OperationStatus { .. } => "operation_status",
            Self::Transfer { action, .. } => action.as_str(),
            Self::Domain { .. } => "domain",
        }
    }
    pub fn is_write(&self) -> bool {
        matches!(
            self,
            Self::Remember { .. }
                | Self::Forget { .. }
                | Self::Transfer { .. }
                | Self::Domain {
                    action: DomainAction::Create
                        | DomainAction::Attach
                        | DomainAction::Detach
                        | DomainAction::Delete,
                    ..
                }
        )
    }
}

fn repository(request: &Request) -> Result<&RepositoryId> {
    Ok(&request
        .targets
        .first()
        .context("repository target is required")?
        .repository_id)
}

fn validate_placement(
    connection: &rusqlite::Connection,
    repository: &RepositoryId,
    placement: &PlacementId,
) -> Result<()> {
    match placement {
        PlacementId::Repository(id) => ensure!(
            id == repository,
            "repository placement must match request repository"
        ),
        PlacementId::Universal => {}
        PlacementId::Domain(domain) => {
            ensure!(
                store::domains(connection)?.contains(domain),
                "domain {domain} does not exist"
            );
            ensure!(
                store::attached_domains(connection, repository)?.contains(domain),
                "domain {domain} is not attached to this repository"
            );
        }
    }
    Ok(())
}

fn sources(
    connection: &rusqlite::Connection,
    repository: &RepositoryId,
    placement: Option<&PlacementId>,
) -> Result<Vec<store::VisibleSource>> {
    match placement {
        Some(placement) => {
            validate_placement(connection, repository, placement)?;
            Ok(vec![store::single_visible_source(placement.clone())])
        }
        None => store::visible_sources(connection, repository),
    }
}

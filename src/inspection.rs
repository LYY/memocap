use crate::{activity, scope::RepositoryId, store};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const CAPABILITIES: &[&str] = &[
    "receipt_v1",
    "recall_match",
    "multi_target",
    "inventory",
    "activity",
    "read_only_status",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inspection {
    pub core_status: String,
    pub schema_version: Option<String>,
    pub visible: Option<store::VisibleStackStatus>,
    pub activity_status: String,
    pub activity_error: Option<String>,
    pub capabilities: Vec<String>,
}

pub fn inspect(database: &Path, repository: &RepositoryId) -> Result<Inspection> {
    inspect_using(database, repository, store::open_strict_readonly)
}

pub(crate) fn inspect_runtime(database: &Path, repository: &RepositoryId) -> Result<Inspection> {
    inspect_using(database, repository, store::open_readonly)
}

fn inspect_using(
    database: &Path,
    repository: &RepositoryId,
    open: fn(&Path) -> Result<rusqlite::Connection>,
) -> Result<Inspection> {
    let visible = if database.try_exists()? {
        let connection = open(database)?;
        Some(store::visible_status(
            &connection,
            &store::visible_sources(&connection, repository)?,
        )?)
    } else {
        None
    };
    let (activity_status, activity_error) = if activity::activity_path(database).try_exists()? {
        match activity::ActivityStore::open_readonly(database) {
            Ok(_) => ("ready", None),
            Err(error) => ("degraded", Some(error.to_string())),
        }
    } else {
        ("not_initialized", None)
    };
    Ok(Inspection {
        core_status: if visible.is_some() {
            "ready"
        } else {
            "not_initialized"
        }
        .into(),
        schema_version: visible.as_ref().map(|status| status.schema_version.clone()),
        visible,
        activity_status: activity_status.into(),
        activity_error,
        capabilities: CAPABILITIES
            .iter()
            .map(|capability| (*capability).into())
            .collect(),
    })
}

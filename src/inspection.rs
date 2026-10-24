use crate::{scope::RepositoryId, store};
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
    "single_database",
    "schema_2_compatible",
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
    inspect_using(database, repository, |path| {
        store::open_strict_readonly(path, std::time::Duration::from_secs(5))
    })
}

pub(crate) fn inspect_runtime(database: &Path, repository: &RepositoryId) -> Result<Inspection> {
    inspect_using(database, repository, store::open_readonly)
}

fn inspect_using(
    database: &Path,
    repository: &RepositoryId,
    open: fn(&Path) -> Result<rusqlite::Connection>,
) -> Result<Inspection> {
    let (status, version, visible) = if database.try_exists()? {
        let connection = open(database)?;
        let version = store::schema::version(&connection)?;
        let actual_version = Some(format!("{}.{}", version.major, version.minor));
        if version.needs_upgrade() {
            ("upgrade_needed", actual_version, None)
        } else {
            (
                "ready",
                actual_version,
                Some(store::visible_status(
                    &connection,
                    &store::visible_sources(&connection, repository)?,
                )?),
            )
        }
    } else {
        ("not_initialized", None, None)
    };
    Ok(Inspection {
        core_status: status.into(),
        schema_version: version,
        visible,
        activity_status: status.into(),
        activity_error: None,
        capabilities: CAPABILITIES
            .iter()
            .map(|capability| (*capability).into())
            .collect(),
    })
}

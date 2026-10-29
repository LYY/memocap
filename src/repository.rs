use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

use crate::scope::RepositoryId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameSource {
    Remote,
    GitCommonDirectory,
    Directory,
}

impl NameSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::GitCommonDirectory => "git_common_directory",
            Self::Directory => "directory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Local,
    ClientReported,
}

impl Origin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::ClientReported => "client_reported",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub display_name: String,
    pub name_source: NameSource,
    pub origin: Origin,
    pub normalized_remote: Option<String>,
}

impl Descriptor {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.display_name.trim().is_empty(),
            "repository display name is empty"
        );
        ensure!(
            self.normalized_remote
                .as_ref()
                .is_none_or(|value| !value.trim().is_empty()),
            "repository remote is empty"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub display_name: String,
    pub name_source: String,
    pub origin: String,
    pub normalized_remote: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub canonical_path: PathBuf,
    pub observed_at: String,
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Context {
    pub identity: Option<Identity>,
    pub locations: Vec<Location>,
}

pub type Contexts = BTreeMap<String, Context>;

pub(crate) fn record_identity(
    connection: &Connection,
    repository: &RepositoryId,
    descriptor: &Descriptor,
) -> Result<()> {
    descriptor.validate()?;
    connection.execute(
        "INSERT INTO repository_identities(repository_id,display_name,name_source,origin,normalized_remote,recorded_at)
         VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(repository_id) DO UPDATE SET
         normalized_remote=coalesce(repository_identities.normalized_remote,excluded.normalized_remote)",
        params![repository.as_str(), descriptor.display_name, descriptor.name_source.as_str(), descriptor.origin.as_str(), descriptor.normalized_remote, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub(crate) fn observe(
    connection: &Connection,
    target: &crate::receipt::Target,
    origin: Origin,
) -> Result<()> {
    if let (Some(path), Some(observed_at)) = (&target.canonical_path, &target.observed_at) {
        connection.execute(
            "INSERT INTO repository_locations(repository_id,canonical_path,observed_at,source) VALUES(?1,?2,?3,?4)
             ON CONFLICT(repository_id,canonical_path) DO UPDATE SET observed_at=excluded.observed_at, source=excluded.source
             WHERE julianday(excluded.observed_at)>=julianday(repository_locations.observed_at)",
            params![target.repository_id.as_str(), path.to_string_lossy(), observed_at, origin.as_str()],
        )?;
    }
    Ok(())
}

pub fn context(connection: &Connection, repository: &RepositoryId) -> Result<Context> {
    let identity = connection.query_row(
        "SELECT display_name,name_source,origin,normalized_remote,recorded_at FROM repository_identities WHERE repository_id=?1",
        [repository.as_str()], |row| Ok(Identity { display_name:row.get(0)?,name_source:row.get(1)?,origin:row.get(2)?,normalized_remote:row.get(3)?,recorded_at:row.get(4)? }),
    ).optional()?;
    let mut statement = connection.prepare("SELECT canonical_path,observed_at,source FROM repository_locations WHERE repository_id=?1 ORDER BY canonical_path")?;
    let locations = statement
        .query_map([repository.as_str()], |row| {
            Ok(Location {
                canonical_path: PathBuf::from(row.get::<_, String>(0)?),
                observed_at: row.get(1)?,
                source: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Context {
        identity,
        locations,
    })
}

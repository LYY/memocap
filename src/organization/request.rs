use super::{Key, MemoryId, Snapshot, UpperId};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Selection {
    #[default]
    Pending,
    All,
    OrganizedReference,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageRequest {
    #[serde(default)]
    pub selection: Selection,
    pub after_id: Option<MemoryId>,
    pub upper_id: Option<UpperId>,
}

impl PageRequest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.after_id.is_none() || self.upper_id.is_some(),
            "after_id requires upper_id"
        );
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub keys: Vec<Key>,
}

impl ReadRequest {
    pub fn validate(&self) -> Result<()> {
        ensure!(!self.keys.is_empty(), "keys must not be empty");
        let unique: HashSet<_> = self.keys.iter().collect();
        ensure!(unique.len() == self.keys.len(), "keys must be unique");
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Pending,
    All,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyRequest {
    pub mode: Mode,
    pub group: Group,
    pub dependencies: Vec<Snapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Group {
    Keep {
        expected: Snapshot,
    },
    Refine {
        expected: Snapshot,
        content: String,
    },
    Delete {
        expected: Snapshot,
    },
    Merge {
        survivor: Snapshot,
        sources: Vec<Snapshot>,
        content: String,
    },
}

impl Group {
    pub fn participants(&self) -> Vec<&Snapshot> {
        match self {
            Self::Keep { expected } | Self::Refine { expected, .. } | Self::Delete { expected } => {
                vec![expected]
            }
            Self::Merge {
                survivor, sources, ..
            } => std::iter::once(survivor).chain(sources).collect(),
        }
    }
}

impl ApplyRequest {
    pub fn validate(&self) -> Result<()> {
        match &self.group {
            Group::Keep { .. } | Group::Delete { .. } => {}
            Group::Refine { content, .. } => {
                ensure!(!content.trim().is_empty(), "content must not be blank")
            }
            Group::Merge {
                survivor,
                sources,
                content,
            } => {
                ensure!(!sources.is_empty(), "merge needs at least one source");
                ensure!(
                    sources
                        .iter()
                        .all(|source| source.placement == survivor.placement),
                    "merge participants must share one placement"
                );
                ensure!(!content.trim().is_empty(), "content must not be blank");
            }
        }
        let mut ids = HashSet::new();
        for snapshot in self
            .group
            .participants()
            .into_iter()
            .chain(&self.dependencies)
        {
            ensure!(
                ids.insert(snapshot.id),
                "participants and dependencies must have distinct IDs"
            );
            if let Some(provenance) = &snapshot.provenance {
                ensure!(
                    provenance.memory_id == snapshot.id,
                    "provenance memory_id differs from snapshot"
                );
            }
        }
        Ok(())
    }
}

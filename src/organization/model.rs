use super::{MemoryId, UpperId};
use crate::{receipt::ids, scope::PlacementId, store::CopyMoveAction};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::PathBuf;

fn required_option<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Repository,
    Domain,
    Universal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub memory_id: MemoryId,
    pub source_memory_id: MemoryId,
    pub source_placement_kind: SourceKind,
    #[serde(deserialize_with = "required_option")]
    pub source_repository_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub source_domain_id: Option<String>,
    pub action: CopyMoveAction,
    pub operation_id: String,
    pub created_at: String,
    #[serde(deserialize_with = "required_option")]
    pub applicability_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub id: MemoryId,
    #[serde(with = "ids")]
    pub placement: PlacementId,
    pub scope: String,
    pub content: String,
    pub kind: String,
    pub tags: String,
    pub topic_key: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(deserialize_with = "required_option")]
    pub organized_at: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub provenance: Option<Provenance>,
}

impl Snapshot {
    pub fn key(&self) -> Key {
        Key {
            id: self.id,
            placement: self.placement.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub id: MemoryId,
    #[serde(with = "ids")]
    pub placement: PlacementId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRecord {
    pub id: MemoryId,
    #[serde(with = "ids")]
    pub placement: PlacementId,
    pub snapshot: Option<Snapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Output {
    Page(Page),
    Read(Read),
    Apply(Applied),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub database: PathBuf,
    pub selection: super::Selection,
    pub upper_id: UpperId,
    pub next_id: Option<MemoryId>,
    pub exhausted: bool,
    pub records: Vec<Snapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    pub database: PathBuf,
    pub records: Vec<ReadRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Applied {
    pub database: PathBuf,
    pub action: Action,
    pub records: Vec<Snapshot>,
    pub deleted: Vec<Key>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Keep,
    Refine,
    Delete,
    Merge,
}

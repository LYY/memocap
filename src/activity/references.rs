use super::{ActivityError, InjectionActivity, ReceiptDetails, Result};
use crate::{discovery::Discovery, scope::PlacementId};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InjectionReference {
    pub id: i64,
    #[serde(with = "super::serde_ids::scalar")]
    pub placement: PlacementId,
    pub completeness: Completeness,
    pub content_hash: ContentHash,
    pub read: ReadRoute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Full,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRoute {
    pub tool: ReadTool,
    pub arguments: ReadArguments,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadTool {
    MemocapRead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadArguments {
    pub id: i64,
    #[serde(with = "super::serde_ids::scalar")]
    pub placement: PlacementId,
    pub content_hash: ContentHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ContentHash(String);

impl<'de> Deserialize<'de> for ContentHash {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let hash = String::deserialize(deserializer)?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(serde::de::Error::custom(
                "content_hash must be 64 lowercase hex characters",
            ));
        }
        Ok(Self(hash))
    }
}

pub(super) fn validate(
    injection: &InjectionActivity,
    receipt: Option<&ReceiptDetails>,
) -> Result<()> {
    if injection.references.len() > 100 {
        return Err(ActivityError::InvalidInput(
            "too many injection references".into(),
        ));
    }
    if !injection.references.is_empty()
        && (injection.discovery.is_none() || injection.truncated.is_none())
    {
        return Err(ActivityError::InvalidInput(
            "references require discovery and truncated metadata".into(),
        ));
    }
    if let (Some(truncated), Some(receipt)) = (injection.truncated, receipt) {
        if truncated != receipt.truncated {
            return Err(ActivityError::InvalidInput(
                "injection and receipt truncation must agree".into(),
            ));
        }
    }
    let injected: HashSet<_> = injection.injected_ids.iter().copied().collect();
    let mut seen = HashSet::new();
    for reference in &injection.references {
        let arguments = &reference.read.arguments;
        if reference.id <= 0
            || !injected.contains(&reference.id)
            || !seen.insert(reference.id)
            || arguments.id != reference.id
            || arguments.placement != reference.placement
            || arguments.content_hash != reference.content_hash
            || reference.placement.to_string().len() > 1024
        {
            return Err(ActivityError::InvalidInput(
                "reference identity, placement, hash and read route must agree with injected IDs"
                    .into(),
            ));
        }
        match reference.completeness {
            Completeness::Full => {}
            Completeness::Partial if injection.truncated == Some(true) => {}
            Completeness::Partial => {
                return Err(ActivityError::InvalidInput(
                    "partial references require truncation".into(),
                ))
            }
        }
        match &injection.discovery {
            Some(Discovery::Origins { placements })
                if !placements.as_slice().contains(&reference.placement) =>
            {
                return Err(ActivityError::InvalidInput(
                    "reference placement must belong to discovery origins".into(),
                ));
            }
            Some(Discovery::Library) | Some(Discovery::Origins { .. }) | None => {}
        }
    }
    Ok(())
}

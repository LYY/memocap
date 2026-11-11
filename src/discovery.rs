use crate::scope::PlacementId;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Discovery {
    Library,
    Origins { placements: Origins },
}

impl<'de> Deserialize<'de> for Discovery {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum Selector {
            Library {},
            Origins { placements: Origins },
        }
        Ok(match Selector::deserialize(deserializer)? {
            Selector::Library {} => Self::Library,
            Selector::Origins { placements } => Self::Origins { placements },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origins(Vec<PlacementId>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidOrigins;

impl std::fmt::Display for InvalidOrigins {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "origins must contain 1 to 100 distinct exact placement IDs of at most 1024 bytes",
        )
    }
}

impl std::error::Error for InvalidOrigins {}

impl TryFrom<Vec<PlacementId>> for Origins {
    type Error = InvalidOrigins;

    fn try_from(placements: Vec<PlacementId>) -> Result<Self, Self::Error> {
        if placements.is_empty() || placements.len() > 100 {
            return Err(InvalidOrigins);
        }
        let mut seen = HashSet::new();
        if placements
            .iter()
            .any(|placement| placement.to_string().len() > 1024 || !seen.insert(placement))
        {
            return Err(InvalidOrigins);
        }
        Ok(Self(placements))
    }
}

impl Origins {
    pub fn as_slice(&self) -> &[PlacementId] {
        &self.0
    }
}

impl Serialize for Origins {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(ToString::to_string))
    }
}

impl<'de> Deserialize<'de> for Origins {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let placements = Vec::<String>::deserialize(deserializer)?
            .into_iter()
            .map(|placement| placement.parse().map_err(serde::de::Error::custom))
            .collect::<Result<Vec<PlacementId>, D::Error>>()?;
        Self::try_from(placements).map_err(serde::de::Error::custom)
    }
}

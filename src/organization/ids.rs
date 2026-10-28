use serde::{Deserialize, Serialize};

const MAX_SAFE_ID: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct MemoryId(i64);

impl TryFrom<i64> for MemoryId {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        if (1..=MAX_SAFE_ID).contains(&value) {
            Ok(Self(value))
        } else {
            Err("memory IDs must be positive JSON-safe integers")
        }
    }
}

impl From<MemoryId> for i64 {
    fn from(id: MemoryId) -> Self {
        id.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct UpperId(i64);

impl TryFrom<i64> for UpperId {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        if (0..=MAX_SAFE_ID).contains(&value) {
            Ok(Self(value))
        } else {
            Err("upper_id must be a nonnegative JSON-safe integer")
        }
    }
}

impl From<UpperId> for i64 {
    fn from(id: UpperId) -> Self {
        id.0
    }
}

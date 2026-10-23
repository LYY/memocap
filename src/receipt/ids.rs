use serde::{Deserialize, Deserializer, Serializer};
use std::{fmt::Display, str::FromStr};

pub fn serialize<T: Display, S: Serializer>(id: &T, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&id.to_string())
}

pub fn deserialize<'de, T, D>(deserializer: D) -> Result<T, D::Error>
where
    T: FromStr,
    T::Err: Display,
    D: Deserializer<'de>,
{
    String::deserialize(deserializer)?
        .parse()
        .map_err(serde::de::Error::custom)
}

pub mod optional {
    use super::*;
    pub fn serialize<T: Display, S: Serializer>(
        id: &Option<T>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&id.as_ref().map(ToString::to_string), serializer)
    }
    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|id| id.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

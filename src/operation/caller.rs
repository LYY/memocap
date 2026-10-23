use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "ReportedCaller")]
pub struct Caller {
    pub actor: String,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportedCaller {
    actor: String,
    session_id: Option<String>,
    message_id: Option<String>,
}

impl Caller {
    pub fn validate(&self) -> Result<()> {
        for (label, text, limit) in std::iter::once(("actor", self.actor.as_str(), 128))
            .chain(self.session_id.as_deref().map(|id| ("session_id", id, 256)))
            .chain(self.message_id.as_deref().map(|id| ("message_id", id, 256)))
        {
            ensure!(
                !text.trim().is_empty()
                    && text.len() <= limit
                    && !text.chars().any(char::is_control),
                "caller {label} must be nonempty bounded metadata without control characters"
            );
        }
        Ok(())
    }
}

impl TryFrom<ReportedCaller> for Caller {
    type Error = anyhow::Error;
    fn try_from(reported: ReportedCaller) -> Result<Self> {
        let caller = Self {
            actor: reported.actor,
            session_id: reported.session_id,
            message_id: reported.message_id,
        };
        caller.validate()?;
        Ok(caller)
    }
}

impl std::str::FromStr for Caller {
    type Err = serde_json::Error;
    fn from_str(encoded: &str) -> std::result::Result<Self, Self::Err> {
        serde_json::from_str(encoded)
    }
}

impl Default for Caller {
    fn default() -> Self {
        Self {
            actor: "cli".into(),
            session_id: None,
            message_id: None,
        }
    }
}

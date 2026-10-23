use super::{ActivityDetail, ActivityError, ActivityEvent, Result};
use chrono::DateTime;

pub(super) fn timestamp(timestamp: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|parsed| parsed.timestamp_millis())
        .map_err(|_| ActivityError::InvalidInput("timestamp must be RFC3339".into()))
}

pub(super) fn text(label: &str, text: &str, limit: usize) -> Result<()> {
    if text.trim().is_empty() || text.len() > limit || text.chars().any(char::is_control) {
        return Err(ActivityError::InvalidInput(format!(
            "{label} must be nonempty, bounded metadata without control characters"
        )));
    }
    Ok(())
}

pub(super) fn event(event: &ActivityEvent) -> Result<i64> {
    let started_at = timestamp(&event.started_at)?;
    text("actor", &event.context.actor, 128)?;
    for identifier in [&event.context.session_id, &event.context.message_id]
        .into_iter()
        .flatten()
    {
        text("session/message ID", identifier, 256)?;
    }
    if event.context.repository_ids.len() > 100 {
        return Err(ActivityError::InvalidInput(
            "too many repository IDs".into(),
        ));
    }
    match &event.detail {
        ActivityDetail::Recall(recall) => {
            if recall.query_terms.len() > 64 || recall.searched_placements.len() > 100 {
                return Err(ActivityError::InvalidInput(
                    "too many query terms or placements".into(),
                ));
            }
            for term in &recall.query_terms {
                text("query term", term, 256)?;
            }
            ids(&recall.matched_ids)?;
            ids(&recall.returned_ids)?;
        }
        ActivityDetail::Write(write) => {
            ids(&write.memory_ids)?;
            if write.placements.len() > 100 {
                return Err(ActivityError::InvalidInput("too many placements".into()));
            }
        }
        ActivityDetail::InjectionPrepared(injection)
        | ActivityDetail::InjectionObserved(injection) => ids(&injection.injected_ids)?,
    }
    if let Some(receipt) = &event.receipt {
        if let Some(code) = &receipt.error_code {
            text("error code", code, 64)?;
            if !code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
            {
                return Err(ActivityError::InvalidInput(
                    "error code must be a structured identifier".into(),
                ));
            }
        }
    }
    Ok(started_at)
}

fn ids(ids: &[i64]) -> Result<()> {
    if ids.len() > 10000 || ids.iter().any(|id| *id <= 0) {
        return Err(ActivityError::InvalidInput(
            "memory IDs must be positive and at most 10000 per stage".into(),
        ));
    }
    Ok(())
}

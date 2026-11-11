use super::{ActivityError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureReviewActivity {
    pub status: CaptureReviewStatus,
    pub reason: String,
    pub memory_ids: Vec<i64>,
    pub model_calls: u64,
    pub tool_calls: u64,
    pub write_attempts: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureReviewStatus {
    Saved,
    Skipped,
    Denied,
    Failed,
    Unknown,
}

pub(super) fn validate(review: &CaptureReviewActivity) -> Result<()> {
    if review.reason.is_empty()
        || review.reason.len() > 64
        || !review
            .reason
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        return Err(ActivityError::InvalidInput(
            "capture reason must be an ASCII identifier of 1 to 64 bytes".into(),
        ));
    }
    if review.model_calls > 3 || review.write_attempts > 1 {
        return Err(ActivityError::InvalidInput(
            "capture review permits at most 3 model calls and 1 write attempt".into(),
        ));
    }
    if review.memory_ids.len() > 100
        || review.memory_ids.iter().any(|id| *id <= 0)
        || review.memory_ids.iter().collect::<HashSet<_>>().len() != review.memory_ids.len()
    {
        return Err(ActivityError::InvalidInput(
            "capture memory IDs must be distinct, positive and at most 100".into(),
        ));
    }
    match review.status {
        CaptureReviewStatus::Saved
            if review.write_attempts != 1 || review.memory_ids.is_empty() =>
        {
            return Err(ActivityError::InvalidInput(
                "saved capture requires one write attempt and memory IDs".into(),
            ));
        }
        CaptureReviewStatus::Skipped if !review.memory_ids.is_empty() => {
            return Err(ActivityError::InvalidInput(
                "skipped capture cannot include memory IDs".into(),
            ));
        }
        CaptureReviewStatus::Saved
        | CaptureReviewStatus::Skipped
        | CaptureReviewStatus::Denied
        | CaptureReviewStatus::Failed
        | CaptureReviewStatus::Unknown => {}
    }
    Ok(())
}

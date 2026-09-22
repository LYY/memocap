use std::path::Path;

use anyhow::Result;

use crate::{scope::RepositoryId, store};

pub fn copy_move(
    database: &Path,
    repository: &RepositoryId,
    input: store::CopyMoveInput,
) -> Result<store::CopyMoveResult> {
    let mut connection = store::open(database)?;
    let request = store::CopyMoveRequest::prepare(repository.clone(), input)?;
    store::copy_move(&mut connection, request)
}

#[must_use]
pub fn format_copy_move(result: &store::CopyMoveResult) -> String {
    format!(
        "{} #{} from {} to {}\noperation_id: {}\n",
        result.action.past_tense(),
        result.memory_id,
        result.from,
        result.to,
        result.operation_id
    )
}

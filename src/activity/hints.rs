use super::{validation, ActivityError, ActivityStore, RepositoryHint, Result};
use crate::scope::RepositoryId;
use rusqlite::{params, OptionalExtension};

impl ActivityStore {
    pub fn repository_hint(&self, repository_id: &RepositoryId) -> Result<Option<RepositoryHint>> {
        let hint = self.connection.query_row(
            "SELECT display_name,canonical_path,identity_source,last_seen FROM repository_metadata WHERE repository_id=?1",
            [repository_id.as_str()], |row| Ok(RepositoryHint {
                repository_id: repository_id.clone(), display_name: row.get(0)?,
                canonical_path: row.get::<_, Option<String>>(1)?.map(Into::into),
                identity_source: row.get(2)?, last_seen: row.get(3)?,
            }),
        ).optional()?;
        if let Some(hint) = &hint {
            validate_hint(hint).map_err(|error| ActivityError::Corrupt(error.to_string()))?;
        }
        Ok(hint)
    }

    pub fn update_repository_hint(&mut self, hint: &RepositoryHint) -> Result<()> {
        let last_seen_ms = validate_hint(hint)?;
        let path = hint
            .canonical_path
            .as_ref()
            .map(|path| {
                path.to_str().ok_or_else(|| {
                    ActivityError::InvalidInput("repository path hint must be UTF-8".into())
                })
            })
            .transpose()?;
        self.connection.execute(
            "INSERT INTO repository_metadata(repository_id,display_name,canonical_path,identity_source,last_seen,last_seen_ms)
             VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(repository_id) DO UPDATE SET
             display_name=coalesce(excluded.display_name,repository_metadata.display_name),
             canonical_path=coalesce(excluded.canonical_path,repository_metadata.canonical_path),
             identity_source=coalesce(excluded.identity_source,repository_metadata.identity_source),
             last_seen=excluded.last_seen,last_seen_ms=excluded.last_seen_ms
             WHERE excluded.last_seen_ms>=repository_metadata.last_seen_ms",
            params![hint.repository_id.as_str(), hint.display_name, path, hint.identity_source, hint.last_seen, last_seen_ms],
        )?;
        Ok(())
    }
}

fn validate_hint(hint: &RepositoryHint) -> Result<i64> {
    if let Some(name) = &hint.display_name {
        validation::text("repository display name", name, 256)?;
    }
    if let Some(source) = &hint.identity_source {
        validation::text("repository identity source", source, 128)?;
    }
    if let Some(path) = &hint.canonical_path {
        let encoded = path.to_str().ok_or_else(|| {
            ActivityError::InvalidInput("repository path hint must be UTF-8".into())
        })?;
        validation::text("repository path hint", encoded, 4096)?;
    }
    validation::timestamp(&hint.last_seen)
}

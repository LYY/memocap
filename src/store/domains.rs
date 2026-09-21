use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::scope::{DomainId, RepositoryId};

pub fn create_domain(connection: &mut Connection, domain: &DomainId) -> Result<bool> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let created = transaction.execute(
        "INSERT INTO domains (domain_id, created_at)
         VALUES (?1, ?2)
         ON CONFLICT(domain_id) DO NOTHING",
        params![domain.as_str(), Utc::now().to_rfc3339()],
    )?;
    transaction.commit()?;
    Ok(created == 1)
}

pub fn domains(connection: &Connection) -> Result<Vec<DomainId>> {
    let mut statement = connection.prepare("SELECT domain_id FROM domains ORDER BY domain_id")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    domain_rows(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn attached_domains(
    connection: &Connection,
    repository: &RepositoryId,
) -> Result<Vec<DomainId>> {
    let mut statement = connection.prepare(
        "SELECT domain_id
         FROM repository_domain_attachments
         WHERE repository_id = ?1
         ORDER BY position",
    )?;
    let rows = statement.query_map(params![repository.as_str()], |row| row.get::<_, String>(0))?;
    domain_rows(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn attach_domain(
    connection: &mut Connection,
    repository: &RepositoryId,
    domain: &DomainId,
    before: Option<&DomainId>,
) -> Result<bool> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_domain(&transaction, domain)?;
    if attachment_position(&transaction, repository, domain)?.is_some() {
        transaction.commit()?;
        return Ok(false);
    }

    let maximum = maximum_position(&transaction, repository)?;
    let position = match before {
        Some(reference) => {
            attachment_position(&transaction, repository, reference)?.ok_or_else(|| {
                anyhow::anyhow!("reference domain {reference} is not attached to this repository")
            })?
        }
        None => next_position(maximum)?,
    };
    if before.is_some() {
        shift_for_insertion(&transaction, repository, position, maximum)?;
    }
    transaction.execute(
        "INSERT INTO repository_domain_attachments (repository_id, domain_id, position)
         VALUES (?1, ?2, ?3)",
        params![repository.as_str(), domain.as_str(), position],
    )?;
    transaction.commit()?;
    Ok(true)
}

pub fn detach_domain(
    connection: &mut Connection,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<bool> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_domain(&transaction, domain)?;
    let Some(position) = attachment_position(&transaction, repository, domain)? else {
        transaction.commit()?;
        return Ok(false);
    };
    transaction.execute(
        "DELETE FROM repository_domain_attachments
         WHERE repository_id = ?1 AND domain_id = ?2",
        params![repository.as_str(), domain.as_str()],
    )?;
    let maximum = maximum_position(&transaction, repository)?;
    if maximum > position {
        shift_after_removal(&transaction, repository, position, maximum)?;
    }
    transaction.commit()?;
    Ok(true)
}

pub fn delete_domain(connection: &mut Connection, domain: &DomainId) -> Result<bool> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !domain_exists(&transaction, domain)? {
        transaction.commit()?;
        return Ok(false);
    }
    let attachments = transaction.query_row(
        "SELECT COUNT(*) FROM repository_domain_attachments WHERE domain_id = ?1",
        params![domain.as_str()],
        |row| row.get::<_, i64>(0),
    )?;
    if attachments != 0 {
        anyhow::bail!("domain {domain} still has {attachments} attachment(s)");
    }
    let memories = transaction.query_row(
        "SELECT COUNT(*) FROM memories WHERE domain_id = ?1",
        params![domain.as_str()],
        |row| row.get::<_, i64>(0),
    )?;
    if memories != 0 {
        anyhow::bail!("domain {domain} still has {memories} memory record(s)");
    }
    transaction.execute(
        "DELETE FROM domains WHERE domain_id = ?1",
        params![domain.as_str()],
    )?;
    transaction.commit()?;
    Ok(true)
}

fn domain_rows(rows: Vec<String>) -> Result<Vec<DomainId>> {
    rows.into_iter()
        .map(|value| {
            value
                .parse::<DomainId>()
                .map_err(|_| anyhow::anyhow!("database contains an invalid domain ID"))
        })
        .collect()
}

fn require_domain(transaction: &rusqlite::Transaction<'_>, domain: &DomainId) -> Result<()> {
    if domain_exists(transaction, domain)? {
        return Ok(());
    }
    anyhow::bail!("domain {domain} does not exist")
}

fn domain_exists(transaction: &rusqlite::Transaction<'_>, domain: &DomainId) -> Result<bool> {
    Ok(transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM domains WHERE domain_id = ?1)",
        params![domain.as_str()],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn attachment_position(
    transaction: &rusqlite::Transaction<'_>,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<Option<i64>> {
    transaction
        .query_row(
            "SELECT position
             FROM repository_domain_attachments
             WHERE repository_id = ?1 AND domain_id = ?2",
            params![repository.as_str(), domain.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(Into::into)
}

fn maximum_position(
    transaction: &rusqlite::Transaction<'_>,
    repository: &RepositoryId,
) -> Result<i64> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(position), -1)
             FROM repository_domain_attachments
             WHERE repository_id = ?1",
            params![repository.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(Into::into)
}

fn next_position(maximum: i64) -> Result<i64> {
    maximum
        .checked_add(1)
        .context("domain attachment position exceeds SQLite range")
}

fn shift_for_insertion(
    transaction: &rusqlite::Transaction<'_>,
    repository: &RepositoryId,
    position: i64,
    maximum: i64,
) -> Result<()> {
    let offset = maximum
        .checked_add(2)
        .context("domain attachment position exceeds SQLite range")?;
    let temporary_start = position
        .checked_add(offset)
        .context("domain attachment position exceeds SQLite range")?;
    transaction.execute(
        "UPDATE repository_domain_attachments
         SET position = position + ?1
         WHERE repository_id = ?2 AND position >= ?3",
        params![offset, repository.as_str(), position],
    )?;
    transaction.execute(
        "UPDATE repository_domain_attachments
         SET position = position - ?1 + 1
         WHERE repository_id = ?2 AND position >= ?3",
        params![offset, repository.as_str(), temporary_start],
    )?;
    Ok(())
}

fn shift_after_removal(
    transaction: &rusqlite::Transaction<'_>,
    repository: &RepositoryId,
    position: i64,
    maximum: i64,
) -> Result<()> {
    let offset = maximum
        .checked_add(2)
        .context("domain attachment position exceeds SQLite range")?;
    let temporary_start = position
        .checked_add(1)
        .and_then(|value| value.checked_add(offset))
        .context("domain attachment position exceeds SQLite range")?;
    transaction.execute(
        "UPDATE repository_domain_attachments
         SET position = position + ?1
         WHERE repository_id = ?2 AND position > ?3",
        params![offset, repository.as_str(), position],
    )?;
    transaction.execute(
        "UPDATE repository_domain_attachments
         SET position = position - ?1 - 1
         WHERE repository_id = ?2 AND position >= ?3",
        params![offset, repository.as_str(), temporary_start],
    )?;
    Ok(())
}

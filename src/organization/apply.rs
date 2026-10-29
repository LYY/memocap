use super::{database, reads, Action, Applied, ApplyRequest, Error, Group, Mode, Result, Snapshot};
use rusqlite::{params, Transaction, TransactionBehavior};
use std::path::Path;

pub fn apply(database: &Path, request: &ApplyRequest) -> Result<Applied> {
    request
        .validate()
        .map_err(|error| Error::before("invalid_request", error))?;
    let database = database::path(database)?;
    let mut connection = database::writable(&database)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(Error::database)?;
    let result = database::validate(&transaction).and_then(|()| mutate(&transaction, request));
    match result {
        Ok((action, records, deleted)) => {
            if let Err(error) = transaction.execute_batch("COMMIT") {
                return rollback(transaction, Error::rolled_back(error));
            }
            Ok(Applied {
                database,
                action,
                records,
                deleted,
            })
        }
        Err(error) if transaction.is_autocommit() => Err(error),
        Err(error) => rollback(transaction, error),
    }
}

fn rollback(transaction: Transaction<'_>, error: Error) -> Result<Applied> {
    transaction.rollback().map_err(|rollback| Error {
        code: "database_error",
        outcome: "outcome_unknown",
        rejected: false,
        message: format!(
            "{}; rollback could not be confirmed: {rollback}",
            error.message
        ),
    })?;
    Err(error)
}

type Postconditions = (Action, Vec<Snapshot>, Vec<super::Key>);

fn check_preconditions(transaction: &Transaction<'_>, request: &ApplyRequest) -> Result<()> {
    let participants = request.group.participants();
    for expected in participants.iter().copied().chain(&request.dependencies) {
        let actual = reads::snapshot(transaction, &expected.key()).map_err(Error::rolled_back)?;
        if actual.as_ref() != Some(expected) {
            return Err(Error::conflict(
                "snapshot_conflict",
                format!(
                    "memory #{} in {} changed or disappeared",
                    i64::from(expected.id),
                    expected.placement
                ),
            ));
        }
    }
    match request.mode {
        Mode::Pending => {
            if participants
                .iter()
                .any(|snapshot| snapshot.organized_at.is_some())
            {
                return Err(Error::conflict("mode_violation", "pending mode cannot mutate organized memories; use all for explicit reassessment"));
            }
        }
        Mode::All => {}
    }
    Ok(())
}

fn mutate(transaction: &Transaction<'_>, request: &ApplyRequest) -> Result<Postconditions> {
    check_preconditions(transaction, request)?;
    let timestamp = chrono::Utc::now().to_rfc3339();
    let (action, survivor, deleted) = match &request.group {
        Group::Keep { expected } => {
            require_one_row(transaction.execute(
                "UPDATE memories SET organized_at=?1 WHERE id=?2",
                params![timestamp, i64::from(expected.id)],
            ))?;
            (Action::Keep, Some(expected), vec![])
        }
        Group::Refine { expected, content } => {
            refine(transaction, expected, content, &timestamp)?;
            (Action::Refine, Some(expected), vec![])
        }
        Group::Delete { expected } => {
            delete(transaction, expected)?;
            (Action::Delete, None, vec![expected.key()])
        }
        Group::Merge {
            survivor,
            sources,
            content,
        } => {
            refine(transaction, survivor, content, &timestamp)?;
            for source in sources {
                delete(transaction, source)?;
            }
            (
                Action::Merge,
                Some(survivor),
                sources.iter().map(Snapshot::key).collect(),
            )
        }
    };
    let records = match survivor {
        Some(expected) => vec![reads::snapshot(transaction, &expected.key())
            .map_err(Error::rolled_back)?
            .ok_or_else(|| Error::rolled_back("survivor missing after mutation"))?],
        None => vec![],
    };
    Ok((action, records, deleted))
}

fn refine(
    transaction: &Transaction<'_>,
    expected: &Snapshot,
    content: &str,
    timestamp: &str,
) -> Result<()> {
    require_one_row(transaction.execute(
        "UPDATE memories SET content=?1,updated_at=?2,organized_at=?2 WHERE id=?3",
        params![content, timestamp, i64::from(expected.id)],
    ))
}

fn delete(transaction: &Transaction<'_>, expected: &Snapshot) -> Result<()> {
    require_one_row(
        transaction.execute("DELETE FROM memories WHERE id=?1", [i64::from(expected.id)]),
    )
}

fn require_one_row(affected: rusqlite::Result<usize>) -> Result<()> {
    match affected {
        Ok(1) => Ok(()),
        Ok(count) => Err(Error::rolled_back(format!(
            "organization write affected {count} rows; expected exactly one"
        ))),
        Err(error) => Err(Error::rolled_back(error)),
    }
}

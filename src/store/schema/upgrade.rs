use super::{
    lex::{self, Token},
    prior, structure, validation,
};
use anyhow::{ensure, Result};
use rusqlite::{Connection, Transaction};

pub(super) fn validate(connection: &Connection) -> Result<()> {
    validation::prior(connection)?;
    for object in structure::objects(connection)? {
        ensure!(
            !object.name.eq_ignore_ascii_case("activity_events_v23"),
            "schema migration table name is already occupied"
        );
        match object.name.as_str() {
            "activity_events" => ensure!(
                lex::table_items(&object.sql)? == lex::table_items(prior::EVENTS)?,
                "schema 2.2 activity table has unsupported extensions"
            ),
            "activity_retention" => {}
            _ => {
                let references_activity =
                    lex::tokens(&object.sql)?.iter().any(|token| match token {
                        Token::Word(identifier) | Token::String(identifier) => {
                            identifier.eq_ignore_ascii_case("activity_events")
                        }
                        Token::Symbol(_) => false,
                    });
                ensure!(
                    !(object.table.eq_ignore_ascii_case("activity_events")
                        || references_activity
                        || object.kind == "trigger"
                            && object.table.eq_ignore_ascii_case("schema_metadata")),
                    "schema 2.2 migration dependency cannot be safely preserved: {}",
                    object.name
                );
            }
        }
    }
    Ok(())
}

pub(super) fn apply(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("
        CREATE TABLE activity_events_v23 (
            sequence INTEGER PRIMARY KEY,
            operation_id TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('write','recall','injection_prepared','injection_observed','capture_review')),
            category TEXT NOT NULL CHECK(category IN ('write','read')),
            started_at_ms INTEGER NOT NULL,
            recorded_at TEXT NOT NULL,
            event_json TEXT NOT NULL,
            UNIQUE(operation_id,phase)
        );
        INSERT INTO activity_events_v23(sequence,operation_id,phase,category,started_at_ms,recorded_at,event_json)
            SELECT sequence,operation_id,phase,category,started_at_ms,recorded_at,event_json FROM activity_events;
        DROP TABLE activity_events;
        ALTER TABLE activity_events_v23 RENAME TO activity_events;
        CREATE INDEX activity_retention ON activity_events(category,started_at_ms DESC,sequence DESC);
    ")?;
    Ok(())
}

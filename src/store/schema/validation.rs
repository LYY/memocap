use super::{
    baseline,
    lex::{self, Token},
    structure::{self, Object},
};
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;

fn expected(organized: bool) -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    match organized {
        true => connection.execute_batch(baseline::CORE)?,
        false => connection
            .execute_batch(&baseline::CORE.replace("    organized_at TEXT DEFAULT NULL,\n", ""))?,
    }
    connection.execute_batch(baseline::ACTIVITY)?;
    Ok(connection)
}

pub(super) fn current(connection: &Connection, organized: bool) -> Result<()> {
    let expected = expected(organized)?;
    if !organized {
        ensure!(
            !structure::columns(connection, "memories")?
                .iter()
                .any(|column| column.name == "organized_at"),
            "schema 2.0 already has organized_at"
        );
    }
    let actual = structure::objects(connection)?;
    for object in structure::objects(&expected)? {
        let existing = actual
            .iter()
            .find(|actual| actual.name == object.name)
            .with_context(|| format!("missing required schema object {}", object.name))?;
        ensure!(
            existing.kind == object.kind && existing.table == object.table,
            "changed schema object {}",
            object.name
        );
        if object.kind == "table" && !object.name.starts_with("memories_fts") {
            table(connection, &expected, existing)?;
        } else {
            ensure!(
                lex::tokens(&existing.sql)? == lex::tokens(&object.sql)?,
                "changed required schema definition {}",
                object.name
            );
            if object.kind == "table" {
                indexes(connection, &expected, &object.name)?;
            }
        }
    }
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    ensure!(
        integrity == "ok",
        "database integrity check failed: {integrity}"
    );
    Ok(())
}

fn table(actual: &Connection, expected: &Connection, object: &Object) -> Result<()> {
    let known = structure::columns(expected, &object.name)?;
    let columns = structure::columns(actual, &object.name)?;
    for column in &known {
        ensure!(
            columns.iter().find(|existing| existing.name == column.name) == Some(column),
            "changed required column {}.{}",
            object.name,
            column.name
        );
    }
    for extra in columns
        .iter()
        .filter(|column| !known.iter().any(|known| known.name == column.name))
    {
        ensure!(
            extra.primary == 0 && extra.hidden == 0,
            "incompatible additional column {}.{}",
            object.name,
            extra.name
        );
        if extra.required {
            let default = extra
                .default
                .as_ref()
                .context("additional required column has no default")?;
            let usable: bool =
                actual.query_row(&format!("SELECT ({default}) IS NOT NULL"), [], |row| {
                    row.get(0)
                })?;
            ensure!(usable, "additional required column has NULL default");
        }
    }
    ensure!(
        structure::foreign_keys(actual, &object.name)?
            == structure::foreign_keys(expected, &object.name)?,
        "changed foreign keys {}",
        object.name
    );
    indexes(actual, expected, &object.name)?;
    let reference: String = expected.query_row(
        "SELECT sql FROM sqlite_schema WHERE name=?1",
        [&object.name],
        |row| row.get(0),
    )?;
    let expected_items = lex::table_items(&reference)?;
    let actual_items = lex::table_items(&object.sql)?;
    for required in &expected_items {
        ensure!(
            actual_items.iter().filter(|item| *item == required).count() == 1,
            "changed required column or constraint {}",
            object.name
        );
    }
    for extra in actual_items
        .iter()
        .filter(|item| !expected_items.contains(item))
    {
        let name = extra
            .first()
            .and_then(Token::word)
            .context("invalid additional schema item")?;
        ensure!(
            columns
                .iter()
                .any(|column| column.name.eq_ignore_ascii_case(name))
                && !known
                    .iter()
                    .any(|column| column.name.eq_ignore_ascii_case(name)),
            "additional constraint is incompatible: {}",
            object.name
        );
        ensure!(
            !extra.iter().skip(1).any(|token| matches!(
                token.word(),
                Some("check" | "references" | "unique" | "primary" | "generated" | "collate")
            )),
            "constrained additional column is incompatible: {}",
            object.name
        );
    }
    Ok(())
}

fn indexes(actual: &Connection, expected: &Connection, table: &str) -> Result<()> {
    let required_indexes = structure::indexes(expected, table)?;
    let actual_indexes = structure::indexes(actual, table)?;
    for index in &required_indexes {
        ensure!(
            actual_indexes.iter().any(|existing| existing == index),
            "changed required index {}",
            index.name
        );
    }
    for extra in actual_indexes.iter().filter(|index| {
        !required_indexes
            .iter()
            .any(|known| known.name == index.name)
    }) {
        ensure!(
            !extra.unique,
            "additional unique index is incompatible: {}",
            extra.name
        );
    }
    Ok(())
}

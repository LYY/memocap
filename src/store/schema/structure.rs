use anyhow::Result;
use rusqlite::{types::Value, Connection};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Column {
    pub name: String,
    pub kind: String,
    pub required: bool,
    pub default: Option<String>,
    pub primary: i64,
    pub hidden: i64,
}

pub(super) fn columns(connection: &Connection, table: &str) -> Result<Vec<Column>> {
    let mut statement = connection.prepare("SELECT name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?1) ORDER BY cid")?;
    let result = statement
        .query_map([table], |row| {
            Ok(Column {
                name: row.get(0)?,
                kind: row.get::<_, String>(1)?.to_ascii_uppercase(),
                required: row.get(2)?,
                default: row.get(3)?,
                primary: row.get(4)?,
                hidden: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

pub(super) fn foreign_keys(connection: &Connection, table: &str) -> Result<Vec<Vec<Value>>> {
    let mut statement = connection.prepare("SELECT seq,\"table\",\"from\",\"to\",on_update,on_delete,\"match\" FROM pragma_foreign_key_list(?1) ORDER BY \"table\",\"from\",seq")?;
    let result = statement
        .query_map([table], |row| {
            (0..7).map(|column| row.get(column)).collect()
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

#[derive(Debug, PartialEq)]
pub(super) struct Index {
    pub name: String,
    pub unique: bool,
    pub origin: String,
    pub partial: bool,
    pub columns: Vec<Vec<Value>>,
}

pub(super) fn indexes(connection: &Connection, table: &str) -> Result<Vec<Index>> {
    let mut statement = connection.prepare(
        "SELECT name,\"unique\",origin,partial FROM pragma_index_list(?1) ORDER BY name",
    )?;
    let entries = statement
        .query_map([table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    entries
        .into_iter()
        .map(|(name, unique, origin, partial)| {
            let mut statement = connection.prepare(
                "SELECT cid,name,\"desc\",coll,\"key\" FROM pragma_index_xinfo(?1) ORDER BY seqno",
            )?;
            let columns = statement
                .query_map([&name], |row| {
                    (0..5).map(|column| row.get(column)).collect()
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(Index {
                name,
                unique,
                origin,
                partial,
                columns,
            })
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub(super) struct Object {
    pub kind: String,
    pub name: String,
    pub table: String,
    pub sql: String,
}

pub(super) fn objects(connection: &Connection) -> Result<Vec<Object>> {
    let mut statement = connection.prepare("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")?;
    let rows = statement
        .query_map([], |row| {
            Ok(Object {
                kind: row.get(0)?,
                name: row.get(1)?,
                table: row.get(2)?,
                sql: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

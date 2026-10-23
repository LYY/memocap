use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub(crate) fn open(path: &Path) -> Result<Connection> {
    let filename = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("database path needs a filename"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let path = parent.canonicalize()?.join(filename);
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.execute_batch("BEGIN;")?;
    Ok(connection)
}

use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

pub fn database() -> (tempfile::TempDir, std::path::PathBuf, Connection) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory.db");
    let connection = memocap::store::open(&path).unwrap();
    (directory, path, connection)
}

pub fn insert(connection: &Connection, content: &str) -> i64 {
    connection
        .execute(
            "INSERT INTO memories(content,created_at,updated_at) VALUES(?1,'created','updated')",
            [content],
        )
        .unwrap();
    connection.last_insert_rowid()
}

pub fn command(path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
    command
        .env("MEMOCAP_DB", path)
        .env("MEMOCAP_HOME", path.parent().unwrap())
        .env_remove("MEMOCAP_ADDR")
        .env_remove("MEMOCAP_URL")
        .env_remove("MEMOCAP_ADDRESS")
        .env_remove("MEMOCAP_TOKEN");
    command
}

pub fn invoke(path: &Path, operation: &str, request: &Value) -> Value {
    let mut child = command(path)
        .args(["organize", operation, "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(request).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let receipt: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)));
    assert_eq!(
        output.status.success(),
        receipt["error"].is_null(),
        "{receipt}"
    );
    receipt
}

pub fn snapshot(path: &Path, id: i64) -> Value {
    invoke(
        path,
        "read",
        &json!({"keys":[{"id":id,"placement":"universal"}]}),
    )["organization"]["records"][0]["snapshot"]
        .clone()
}

pub fn apply(path: &Path, group: Value) -> Value {
    invoke(
        path,
        "apply",
        &json!({"mode":"pending","group":group,"dependencies":[]}),
    )
}

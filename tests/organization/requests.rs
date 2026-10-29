use super::support::*;
use serde_json::{json, Value};
use std::{io::Write, process::Stdio};

#[test]
fn rejects_unknown_nested_fields_and_invalid_provenance_variants() {
    let (_directory, path, connection) = database();
    insert(&connection, "candidate");
    connection.execute_batch("INSERT INTO memory_provenance VALUES(1,8,'universal',NULL,NULL,'copy','op','created',NULL)").unwrap();
    let original = snapshot(&path, 1);

    for (field, replacement) in [("source_placement_kind", "other"), ("action", "other")] {
        let mut invalid = original.clone();
        invalid["provenance"][field] = json!(replacement);
        let receipt = apply(&path, json!({"action":"keep","expected":invalid}));
        assert_eq!(receipt["error"]["code"], "invalid_request");
    }
    let mut invalid = original.clone();
    invalid["provenance"]["extra"] = json!(true);
    assert_eq!(
        apply(&path, json!({"action":"keep","expected":invalid}))["error"]["code"],
        "invalid_request"
    );
    let mut invalid = original;
    invalid["extra"] = json!(true);
    assert_eq!(
        apply(&path, json!({"action":"keep","expected":invalid}))["error"]["code"],
        "invalid_request"
    );
}

#[test]
fn rejects_repository_arguments_with_argument_exit_code() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent").join("memory.db");

    let output = command(&path)
        .args(["organize", "page", "--json", "--repo", "/absent-repository"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["error"]["code"], "invalid_arguments");
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn rejects_malformed_utf8_or_multiple_stdin_objects_without_database_access() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent").join("memory.db");
    for bytes in [b"{} {}".as_slice(), b"{", b"\xff", b"null", b"[]"] {
        let mut child = command(&path)
            .args(["organize", "page", "--json"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();

        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();

        assert_eq!(output.status.code(), Some(1));
        let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["error"]["code"], "invalid_request");
        assert!(!path.parent().unwrap().exists());
    }
}

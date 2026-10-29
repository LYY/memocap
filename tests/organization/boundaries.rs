use super::support::*;
use serde_json::json;

#[test]
fn readonly_missing_and_upgrade_paths_never_prepare_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent").join("memory.db");
    let missing = invoke(&path, "page", &json!({}));
    assert_eq!(missing["error"]["code"], "not_initialized");
    assert!(!path.parent().unwrap().exists());
    let path = directory.path().join("current.db");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("../fixtures/schema-2.0.sql"))
        .unwrap();
    connection.execute_batch("ALTER TABLE memories ADD COLUMN organized_at TEXT DEFAULT NULL; UPDATE schema_metadata SET minor=1;").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    let (_current_directory, current_path, current) = database();
    insert(&current, "valid expected snapshot");
    let expected = snapshot(&current_path, 1);
    for operation in ["page", "read", "apply"] {
        let request = match operation {
            "page" => json!({}),
            "read" => json!({"keys":[{"id":1,"placement":"universal"}]}),
            "apply" => {
                json!({"mode":"pending","group":{"action":"keep","expected":expected},"dependencies":[]})
            }
            _ => unreachable!(),
        };
        assert_eq!(
            invoke(&path, operation, &request)["error"]["code"],
            "upgrade_required"
        );
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn remote_and_help_do_not_access_local_or_require_token() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent").join("memory.db");
    for variable in ["MEMOCAP_ADDR", "MEMOCAP_URL", "MEMOCAP_ADDRESS"] {
        for operation in ["page", "read", "apply"] {
            let output = command(&path)
                .env(variable, "http://127.0.0.1:1")
                .args(["organize", operation, "--json"])
                .output()
                .unwrap();
            let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(receipt["error"]["code"], "unsupported_backend");
        }
    }
    let help = command(&path)
        .env("MEMOCAP_ADDR", "http://127.0.0.1:1")
        .args(["organize", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(!path.parent().unwrap().exists());
}

#[test]
fn rejects_unsafe_ids_unknown_fields_empty_keys_and_missing_null_snapshot_fields() {
    let (_directory, path, connection) = database();
    insert(&connection, "candidate");
    for request in [
        json!({"after_id":1}),
        json!({"upper_id":9007199254740992i64}),
        json!({"extra":true}),
        json!({"selection":"other"}),
    ] {
        assert_eq!(
            invoke(&path, "page", &request)["error"]["code"],
            "invalid_request"
        );
    }
    for id in [0, -1, 9007199254740992i64] {
        assert_eq!(
            invoke(
                &path,
                "read",
                &json!({"keys":[{"id":id,"placement":"universal"}]})
            )["error"]["code"],
            "invalid_request"
        );
    }
    assert_eq!(
        invoke(&path, "read", &json!({"keys":[]}))["error"]["code"],
        "invalid_request"
    );
    let mut original = snapshot(&path, 1);
    original.as_object_mut().unwrap().remove("organized_at");
    assert_eq!(
        apply(&path, json!({"action":"keep","expected":original}))["error"]["code"],
        "invalid_request"
    );
}

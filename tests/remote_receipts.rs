use memocap::{server, store};
use serde_json::{json, Value};
const REPO: &str = "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
#[path = "support/receipt_server.rs"]
mod receipt_server;

fn request(command: Value) -> Value {
    json!({"operation_id":"00000000-0000-0000-0000-000000000311",
        "targets":[{"repository_id":REPO,"canonical_path":null,"identity_source":"explicit","placements":[]}],
        "command":command,"caller":{"actor":"cli","session_id":null,"message_id":null}})
}

#[test]
fn receipt_endpoint_authenticates_and_records_server_commits() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let capabilities = server::dispatch("POST", "/v1/capabilities", true, "{}", &db);
    assert_eq!(capabilities.0, 200);
    assert!(!db.exists());
    let body = request(json!({"operation":"remember","content":"remote real commit","kind":"note","tags":"","topic":null,"force":false,"id":null,"placement":null})).to_string();
    assert_eq!(
        server::dispatch("POST", "/v1/receipt", false, &body, &db).0,
        401
    );
    assert!(!db.exists());
    let (status, response) = server::dispatch("POST", "/v1/receipt", true, &body, &db);
    assert_eq!(status, 200, "{response}");
    let receipt: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(receipt["status"], "inserted");
    assert_eq!(receipt["backend"], "remote");
    assert_eq!(receipt["origin"], "server");
    assert_eq!(receipt["activity_status"], "recorded");
    assert!(!response.contains("Bearer"));
    let core = store::open(&db).unwrap();
    assert_eq!(
        core.query_row("SELECT count(*) FROM memories", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn remote_read_only_status_does_not_initialize_core() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("missing.db");
    let body = request(json!({"operation":"status","read_only":true})).to_string();
    let (status, response) = server::dispatch("POST", "/v1/receipt", true, &body, &db);
    assert_eq!(status, 200, "{response}");
    let receipt: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(receipt["inspection"]["core_status"], "not_initialized");
    assert!(!db.exists());
}

#[test]
fn legacy_recall_records_the_actual_server_query() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let body = request(json!({"operation":"remember","content":"legacy recall proof","kind":"note","tags":"","topic":null,"force":false,"id":null,"placement":null})).to_string();
    assert_eq!(
        server::dispatch("POST", "/v1/receipt", true, &body, &db).0,
        200
    );
    let body = json!({"repository":REPO,"query":"legacy","limit":3,"placement":null,"type":null,"max_chars":null}).to_string();
    let (status, response) = server::dispatch("POST", "/v1/memories/recall", true, &body, &db);
    assert_eq!(status, 200, "{response}");
    let events = memocap::activity::ActivityStore::open_readonly(&db)
        .unwrap()
        .list(&memocap::activity::ActivityQuery::default())
        .unwrap();
    assert!(events.iter().any(|entry| matches!(&entry.event.detail, memocap::activity::ActivityDetail::Recall(query) if query.returned_ids == vec![1])));
}

#[test]
fn old_server_is_refused_before_sending_a_write() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let (address, handle) = receipt_server::start(db.clone(), receipt_server::Mode::Old, 1);
    let input = serde_json::from_value(request(json!({"operation":"remember","content":"must not commit","kind":"note","tags":"","topic":null,"force":false,"id":null,"placement":null}))).unwrap();
    assert!(memocap::remote::execute_receipt(&address, "receipt-test-token", &input).is_err());
    assert_eq!(handle.join().unwrap(), vec!["/v1/capabilities"]);
    assert!(!db.exists());
}

#[test]
fn malformed_write_response_reports_unknown_without_replaying() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let (address, handle) =
        receipt_server::start(db.clone(), receipt_server::Mode::MalformedWrite, 2);
    let input = serde_json::from_value(request(json!({"operation":"remember","content":"committed once over wire","kind":"note","tags":"","topic":null,"force":false,"id":null,"placement":null}))).unwrap();
    let receipt = memocap::remote::execute_receipt(&address, "receipt-test-token", &input).unwrap();
    assert_eq!(receipt.status, memocap::receipt::Status::OutcomeUnknown);
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("receipt-test-token"));
    assert_eq!(
        handle.join().unwrap(),
        vec!["/v1/capabilities", "/v1/receipt"]
    );
    let core = store::open(&db).unwrap();
    assert_eq!(
        core.query_row("SELECT count(*) FROM memories", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn real_remote_cli_supports_any_match_inventory_and_server_activity() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let (address, handle) = receipt_server::start(db, receipt_server::Mode::Normal, 8);
    let run = |args: &[&str]| {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_memocap"))
            .args(args)
            .arg("--json")
            .current_dir(dir.path())
            .env("MEMOCAP_HOME", dir.path())
            .env("MEMOCAP_ADDR", &address)
            .env("MEMOCAP_TOKEN", "receipt-test-token")
            .env("MEMOCAP_DB", dir.path().join("client-must-not-exist.db"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    run(&["remember", "remote apple"]);
    let recalled = run(&["recall", "apple pear", "--match", "any"]);
    assert_eq!(recalled["results"][0]["memory"]["content"], "remote apple");
    assert_eq!(recalled["backend"], "remote");
    assert_eq!(recalled["origin"], "server");
    let inventory = run(&["scope", "list", "--all"]);
    assert_eq!(
        inventory["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["count"].as_i64().unwrap())
            .sum::<i64>(),
        1
    );
    let activity = run(&["activity", "list", "--writes"]);
    assert_eq!(activity["events"].as_array().unwrap().len(), 1);
    assert_eq!(activity["events"][0]["context"]["origin"], "server");
    assert!(!dir.path().join("client-must-not-exist.db").exists());
    assert_eq!(handle.join().unwrap().len(), 8);
}

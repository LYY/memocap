use super::{receipt_cli, receipt_server, store, Termination, REPO};
use serde_json::{json, Value};

#[test]
fn remote_cli_exact_read_roundtrips_full_authoritative_body_and_mismatch() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("server.db");
    let connection = store::open(&database).unwrap();
    let origin = "repository:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let content = format!(
        "{}\n尾部约束: never use production.",
        "full read 🦀 \"quote\" ".repeat(500)
    );
    let id = store::remember_at(
        &connection,
        &origin.parse().unwrap(),
        &content,
        "note",
        "",
        store::RememberOptions {
            topic_key: None,
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap();
    let id_text = id.to_string();
    let (address, server) = receipt_server::start(database, receipt_server::Mode::Normal, 4);

    let attempts = receipt_cli::run(
        directory.path(),
        &address,
        &[
            &[
                "--repository-id",
                REPO,
                "read",
                &id_text,
                "--placement",
                origin,
            ],
            &[
                "--repository-id",
                REPO,
                "read",
                &id_text,
                "--placement",
                REPO,
            ],
        ],
    );
    let report = server.join();

    assert_eq!(attempts.len(), 2);
    assert!(
        attempts.iter().all(|attempt| attempt.success),
        "{attempts:?}"
    );
    let receipt: Value = serde_json::from_str(&attempts[0].stdout).unwrap();
    assert_eq!(receipt["operation"], "read");
    assert_eq!(receipt["backend"], "remote");
    assert_eq!(receipt["origin"], "server");
    assert_eq!(receipt["results"][0]["memory"]["content"], content);
    assert_eq!(receipt["results"][0]["memory"]["placement"], origin);
    assert_eq!(receipt["results"][0]["applicability"], "unknown");
    assert_eq!(receipt["results"][0]["applicable_repositories"], json!([]));
    let mismatch: Value = serde_json::from_str(&attempts[1].stdout).unwrap();
    assert_eq!(mismatch["status"], "empty");
    assert_eq!(mismatch["results"], json!([]));
    assert_eq!(mismatch["returned_ids"], json!([]));
    assert!(matches!(report.termination, Termination::Completed));
    assert_eq!(
        report.paths(),
        ["/v1/capabilities", "/v1/receipt"].repeat(2)
    );
    assert!(!directory.path().join("client-must-not-exist.db").exists());
}

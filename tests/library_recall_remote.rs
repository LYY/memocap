#[path = "support/receipt_server.rs"]
#[expect(
    dead_code,
    reason = "Shared server failure modes are exercised in remote_receipts."
)]
mod receipt_server;
#[path = "support/observable.rs"]
#[expect(
    dead_code,
    reason = "Shared CLI fixture also supports a second repository directory."
)]
mod support;

use memocap::{
    discovery::{Discovery, Origins},
    remote, server,
    store::MatchMode,
};
use serde_json::{json, Value};

const OTHER: &str = "repository:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn real_remote_library_and_exact_origins_match_local_json_and_plaintext() {
    let fixture = support::Fixture::new();
    let saved = fixture.json(
        &[
            "--repository-id",
            OTHER,
            "remember",
            "telescope remote origin",
            "--topic",
            "optics",
            "--json",
        ],
        true,
    );
    fixture.json(
        &[
            "remember",
            "telescope universal",
            "--universal",
            "--topic",
            "optics",
            "--json",
        ],
        true,
    );
    let local = fixture.json(&["recall", "telescope", "--library", "--json"], true);
    let local_plain = fixture
        .command(&["recall", "telescope", "--library"])
        .output()
        .unwrap();
    let (address, worker) =
        receipt_server::start(fixture.database.clone(), receipt_server::Mode::Normal, 11);
    let run = |args: &[&str]| {
        let output = fixture
            .command(args)
            .env("MEMOCAP_ADDR", &address)
            .env("MEMOCAP_TOKEN", "receipt-test-token")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };

    let library: Value =
        serde_json::from_slice(&run(&["recall", "telescope", "--library", "--json"]).stdout)
            .unwrap();
    let plain = run(&["recall", "telescope", "--library"]);
    let budgeted: Value =
        serde_json::from_slice(&run(&["recall", "telescope", "--max-chars", "1", "--json"]).stdout)
            .unwrap();
    let budgeted_plain = run(&["recall", "telescope", "--max-chars", "1"]);
    let selected: Value = serde_json::from_slice(
        &run(&["recall", "telescope", "--placement", OTHER, "--json"]).stdout,
    )
    .unwrap();
    let repository = memocap::scope::resolve_readonly(&fixture.a).unwrap();
    let legacy = remote::recall(
        &address,
        "receipt-test-token",
        remote::RecallRequest {
            repository: repository.repository(),
            discovery: &Discovery::Origins {
                placements: Origins::try_from(vec![OTHER.parse().unwrap()]).unwrap(),
            },
            match_mode: MatchMode::All,
            query: "telescope",
            limit: 20,
            kind: None,
            max_chars: None,
        },
    )
    .unwrap();
    let report = worker.join();

    assert!(matches!(
        report.termination,
        receipt_server::Termination::Completed
    ));
    assert_eq!(library["results"], local["results"]);
    assert_eq!(library["matched_ids"], local["matched_ids"]);
    assert_eq!(library["searched_placements"], local["searched_placements"]);
    assert_eq!(plain.stdout, local_plain.stdout);
    assert_eq!(budgeted["matched_ids"], local["matched_ids"]);
    assert_eq!(budgeted["results"], json!([]));
    assert_eq!(budgeted["returned_ids"], json!([]));
    assert_eq!(budgeted["truncated"], true);
    assert!(!String::from_utf8(budgeted_plain.stdout)
        .unwrap()
        .contains("telescope"));
    assert_eq!(selected["returned_ids"], saved["returned_ids"]);
    assert_eq!(legacy.len(), 1);
    assert_eq!(
        serde_json::to_value(&legacy[0].memory).unwrap(),
        selected["results"][0]["memory"]
    );
}

#[test]
fn both_remote_routes_reject_missing_empty_and_obsolete_recall_selectors() {
    let fixture = support::Fixture::new();
    for discovery in [
        None,
        Some(json!({"kind":"origins","placements":[]})),
        Some(json!({"kind":"origins","placements":["universal","universal"]})),
    ] {
        let mut command = json!({"operation":"recall","query":"telescope","match_mode":"all","limit":3,"kind":null,"max_chars":null});
        let mut legacy = json!({"repository":OTHER,"query":"telescope","match_mode":"all","limit":3,"type":null,"max_chars":null});
        if let Some(discovery) = discovery {
            command["discovery"] = discovery.clone();
            legacy["discovery"] = discovery;
        }
        let request = json!({"operation_id":"00000000-0000-0000-0000-000000000311",
            "targets":[{"repository_id":OTHER,"canonical_path":null,"identity_source":"explicit","placements":[]}], "command":command});

        assert_eq!(
            server::dispatch(
                "POST",
                "/v1/receipt",
                true,
                &request.to_string(),
                &fixture.database
            )
            .0,
            400
        );
        assert_eq!(
            server::dispatch(
                "POST",
                "/v1/memories/recall",
                true,
                &legacy.to_string(),
                &fixture.database
            )
            .0,
            400
        );
    }
    let obsolete = json!({"repository":OTHER,"query":"telescope","match_mode":"all","limit":3,"placement":null,"discovery":{"kind":"library"}});
    assert_eq!(
        server::dispatch(
            "POST",
            "/v1/memories/recall",
            true,
            &obsolete.to_string(),
            &fixture.database
        )
        .0,
        400
    );
    assert!(!fixture.database.exists());
}

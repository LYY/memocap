#[path = "support/observable.rs"]
mod support;
use serde_json::json;
use support::Fixture;

const OTHER: &str = "repository:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn library_recall_searches_other_repository_without_claiming_applicability() {
    let fixture = Fixture::new();
    let saved = fixture.json(
        &[
            "--repo",
            fixture.b.to_str().unwrap(),
            "remember",
            "distant telescope",
            "--json",
        ],
        true,
    );

    let receipt = fixture.json(&["recall", "telescope", "--library", "--json"], true);

    assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
    assert_eq!(receipt["discovery"], json!({"kind":"library"}));
    assert_eq!(receipt["results"][0]["applicability"], "unknown");
    assert_eq!(receipt["results"][0]["applicable_repositories"], json!([]));
}

#[test]
fn recall_ranks_relevance_before_origin_and_preserves_same_topic_candidates() {
    let fixture = Fixture::new();
    fixture.json(
        &[
            "remember",
            "telescope weak filler filler filler filler filler filler filler filler",
            "--topic",
            "optics",
            "--json",
        ],
        true,
    );
    let strong = fixture.json(
        &[
            "remember",
            "telescope telescope telescope",
            "--universal",
            "--topic",
            "optics",
            "--tags",
            "astronomy",
            "--json",
        ],
        true,
    );

    let receipt = fixture.json(&["recall", "telescope", "--json"], true);

    assert_eq!(receipt["returned_ids"].as_array().unwrap().len(), 2);
    assert_eq!(receipt["returned_ids"][0], strong["returned_ids"][0]);
    assert_eq!(receipt["results"][0]["memory"]["tags"], "astronomy");
    assert_eq!(receipt["results"][0]["memory"]["topic_key"], "optics");
    let limited = fixture.json(
        &[
            "recall",
            "telescope",
            "--limit",
            "1",
            "--max-chars",
            "1",
            "--json",
        ],
        true,
    );
    assert_eq!(limited["returned_ids"], json!([]));
    assert_eq!(limited["results"], json!([]));
    assert_eq!(limited["status"], "empty");
    assert_eq!(
        receipt["results"][0]["memory"]["content"],
        "telescope telescope telescope"
    );
    assert_eq!(limited["matched_ids"], receipt["matched_ids"]);
    assert_eq!(limited["truncated"], true);
}

#[test]
fn exact_origins_include_other_repository_and_unattached_domain_without_expansion() {
    let fixture = Fixture::new();
    let other = fixture.json(
        &[
            "--repository-id",
            OTHER,
            "remember",
            "telescope elsewhere",
            "--json",
        ],
        true,
    );
    fixture.json(&["scope", "domain", "create", "optics", "--json"], true);
    fixture.json(&["scope", "domain", "attach", "optics", "--json"], true);
    let domain = fixture.json(
        &[
            "remember",
            "telescope domain",
            "--domain",
            "optics",
            "--json",
        ],
        true,
    );
    fixture.json(&["scope", "domain", "detach", "optics", "--json"], true);
    fixture.json(&["remember", "telescope excluded", "--json"], true);

    let selected = fixture.json(
        &[
            "recall",
            "telescope",
            "--placement",
            OTHER,
            "--placement",
            "domain:optics",
            "--json",
        ],
        true,
    );

    let ids = selected["returned_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&other["returned_ids"][0]));
    assert!(ids.contains(&domain["returned_ids"][0]));
    assert_eq!(
        selected["searched_placements"],
        json!([OTHER, "domain:optics"])
    );
    assert_eq!(
        selected["discovery"],
        json!({"kind":"origins","placements":[OTHER,"domain:optics"]})
    );
    assert!(selected["repository_context"].get(OTHER).is_some());
    let alias = fixture.json(
        &["recall", "telescope", "--domain", "optics", "--json"],
        true,
    );
    assert_eq!(alias["returned_ids"], domain["returned_ids"]);
    let library = fixture.json(&["recall", "telescope", "--json"], true);
    assert_eq!(library["returned_ids"].as_array().unwrap().len(), 3);
}

#[test]
fn recall_rejects_conflicting_and_duplicate_cli_selectors_before_opening_database() {
    let fixture = Fixture::new();
    for arguments in [
        vec![
            "recall",
            "query",
            "--library",
            "--placement",
            "universal",
            "--json",
        ],
        vec![
            "recall",
            "query",
            "--library",
            "--domain",
            "optics",
            "--json",
        ],
        vec![
            "recall",
            "query",
            "--placement",
            "universal",
            "--universal",
            "--json",
        ],
        vec![
            "recall",
            "query",
            "--placement",
            "universal",
            "--placement",
            "universal",
            "--json",
        ],
    ] {
        assert_eq!(fixture.json(&arguments, false)["status"], "failed");
    }
    assert!(!fixture.database.exists());
}

#[test]
fn recall_wire_requires_nonempty_explicit_discovery_and_keeps_targets_as_context() {
    let fixture = Fixture::new();
    let command = json!({"operation":"recall","query":"telescope","match_mode":"all","limit":3,"kind":null,"max_chars":null});
    for selector in [
        None,
        Some(json!({"kind":"origins","placements":[]})),
        Some(json!({"kind":"origins","placements":["universal","universal"]})),
        Some(json!({"kind":"library","placements":[]})),
    ] {
        let mut input = command.clone();
        if let Some(selector) = selector {
            input["discovery"] = selector;
        }
        assert!(serde_json::from_value::<memocap::operation::Command>(input).is_err());
    }
    let mut valid = command;
    valid["discovery"] = json!({"kind":"library"});
    let request = memocap::operation::Request {
        operation_id: "00000000-0000-0000-0000-000000000311".parse().unwrap(),
        targets: vec![],
        command: serde_json::from_value(valid).unwrap(),
        caller: Default::default(),
    };
    let receipt = memocap::operation::execute(
        &fixture.database,
        &request,
        memocap::activity::ActivityBackend::Local,
    );
    assert!(!receipt.succeeded());
    assert!(!fixture.database.exists());
}

#[test]
fn default_library_and_explicit_library_have_identical_plain_and_json_candidates() {
    let fixture = Fixture::new();
    fixture.json(
        &[
            "--repository-id",
            OTHER,
            "remember",
            "telescope parity",
            "--json",
        ],
        true,
    );

    let default = fixture.json(&["recall", "telescope", "--json"], true);
    let explicit = fixture.json(&["recall", "telescope", "--library", "--json"], true);
    let plain = fixture.command(&["recall", "telescope"]).output().unwrap();

    assert_eq!(default["results"], explicit["results"]);
    assert!(plain.status.success());
    let text = String::from_utf8(plain.stdout).unwrap();
    assert!(text.contains("telescope parity"));
    assert!(text.contains(OTHER));
    assert!(text.contains("applicability: unknown"));
}

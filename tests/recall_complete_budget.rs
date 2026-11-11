#[path = "support/observable.rs"]
mod support;
use serde_json::json;
use support::Fixture;

#[test]
fn recall_with_zero_budget_omits_bodies_but_preserves_ranked_matches() {
    let fixture = Fixture::new();
    let weak = fixture.json(
        &["remember", "alpha repository weak result", "--json"],
        true,
    );
    let strong = fixture.json(
        &[
            "remember",
            "alpha alpha alpha universal strong result",
            "--universal",
            "--json",
        ],
        true,
    );

    let receipt = fixture.json(
        &[
            "recall",
            "alpha",
            "--limit",
            "1",
            "--max-chars",
            "0",
            "--json",
        ],
        true,
    );

    assert_eq!(
        receipt["matched_ids"],
        json!([strong["returned_ids"][0], weak["returned_ids"][0]])
    );
    assert_eq!(receipt["results"], json!([]));
    assert_eq!(receipt["returned_ids"], json!([]));
    assert_eq!(receipt["truncated"], true);
    assert_eq!(receipt["status"], "empty");
}

#[test]
fn recall_returns_authoritative_unicode_body_only_when_entire_body_fits() {
    let fixture = Fixture::new();
    let source = format!(
        "integrity {} Do NOT deploy without approval.",
        "中🙂e\u{301}".repeat(1600)
    );
    let saved = fixture.json(&["remember", &source, "--json"], true);
    let id = saved["returned_ids"][0].to_string();
    let exact = source.chars().count();

    for budget in [0, 6000, exact - 1, exact, exact + 1] {
        let receipt = fixture.json(
            &[
                "recall",
                "integrity",
                "--max-chars",
                &budget.to_string(),
                "--json",
            ],
            true,
        );

        assert_eq!(receipt["matched_ids"], saved["returned_ids"]);
        if budget < exact {
            assert_eq!(receipt["results"], json!([]));
            assert_eq!(receipt["returned_ids"], json!([]));
            assert_eq!(receipt["truncated"], true);
            assert_eq!(receipt["status"], "empty");
        } else {
            assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
            assert_eq!(
                receipt["results"][0]["memory"]["content"]
                    .as_str()
                    .unwrap()
                    .as_bytes(),
                source.as_bytes()
            );
            assert_eq!(receipt["truncated"], false);
        }
    }

    let placement = saved["results"][0]["memory"]["placement"].as_str().unwrap();
    let read = fixture.json(&["read", &id, "--placement", placement, "--json"], true);
    assert_eq!(read["returned_ids"], saved["returned_ids"]);
    assert_eq!(
        read["results"][0]["memory"]["content"]
            .as_str()
            .unwrap()
            .as_bytes(),
        source.as_bytes()
    );
    let unbudgeted = fixture.json(&["recall", "integrity", "--json"], true);
    assert_eq!(unbudgeted["results"][0]["memory"]["content"], source);
    assert_eq!(unbudgeted["truncated"], false);
}

#[test]
fn recall_stops_at_first_oversized_ranked_record_without_backfilling() {
    let fixture = Fixture::new();
    let oversized = "ranking ranking ranking ranking ranking ranking";
    let first = fixture.json(&["remember", oversized, "--json"], true);
    fixture.json(&["remember", "ranking", "--universal", "--json"], true);
    let complete = fixture.json(&["recall", "ranking", "--json"], true);
    assert_eq!(complete["returned_ids"][0], first["returned_ids"][0]);

    let placement = first["results"][0]["memory"]["placement"].as_str().unwrap();
    for selector in [
        vec!["--library"],
        vec!["--placement", placement, "--placement", "universal"],
    ] {
        let mut args = vec!["recall", "ranking", "--max-chars", "7", "--json"];
        args.extend(selector);
        let receipt = fixture.json(&args, true);

        assert_eq!(receipt["matched_ids"], complete["matched_ids"]);
        assert_eq!(receipt["results"], json!([]));
        assert_eq!(receipt["truncated"], true);
    }

    let plain = fixture
        .command(&[
            "--repo",
            fixture.b.to_str().unwrap(),
            "recall",
            "ranking",
            "--max-chars",
            "7",
        ])
        .output()
        .unwrap();
    assert!(plain.status.success());
    assert!(!String::from_utf8(plain.stdout).unwrap().contains(oversized));
}

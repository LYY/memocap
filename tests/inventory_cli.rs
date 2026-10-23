#[path = "support/observable.rs"]
mod support;
use support::Fixture;

#[test]
fn full_inventory_and_exact_pagination_include_other_repositories() {
    let f = Fixture::new();
    f.json(&["remember", "first record", "--json"], true);
    f.json(&["remember", "second record", "--force", "--json"], true);
    let b = f.json(
        &[
            "remember",
            "outside visible",
            "--repo",
            f.b.to_str().unwrap(),
            "--json",
        ],
        true,
    );
    let inventory = f.json(&["scope", "list", "--all", "--json"], true);
    assert_eq!(
        inventory["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["count"].as_i64().unwrap())
            .sum::<i64>(),
        3
    );
    let placement = b["targets"][0]["repository_id"].as_str().unwrap();
    let exact = f.json(
        &[
            "list",
            "--placement",
            placement,
            "--limit",
            "1",
            "--offset",
            "0",
            "--json",
        ],
        true,
    );
    assert_eq!(exact["results"][0]["memory"]["content"], "outside visible");
    assert_eq!(
        exact["results"][0]["applicable_repositories"],
        serde_json::json!([placement])
    );
    assert!(exact["results"][0]["memory"]["updated_at"].is_string());
    let end = f.json(
        &["list", "--placement", placement, "--offset", "1", "--json"],
        true,
    );
    assert_eq!(end["status"], "empty");
}

#[test]
fn exact_inventory_retains_shadow_visibility_in_the_selected_repository() {
    let f = Fixture::new();
    f.json(
        &[
            "remember",
            "shared setting",
            "--topic",
            "setting",
            "--universal",
            "--json",
        ],
        true,
    );
    f.json(
        &["remember", "local setting", "--topic", "setting", "--json"],
        true,
    );
    let receipt = f.json(&["list", "--placement", "universal", "--json"], true);
    assert_eq!(receipt["results"][0]["visibility"], "shadowed");
}

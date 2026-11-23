#[path = "maintenance_native/support.rs"]
mod support;
use serde_json::json;
use support::Fixture;

#[test]
fn refine_commits_preserves_metadata_and_produces_trusted_activity() {
    let fixture = Fixture::new();
    fixture.connection.execute_batch("UPDATE memories SET kind='decision',tags='retained',topic_key='topic',organized_at='previous' WHERE id=1;
        INSERT INTO memory_provenance VALUES(1,9,'universal',NULL,NULL,'copy','fixture-provenance','created',NULL);
        ALTER TABLE memories ADD COLUMN extra TEXT DEFAULT 'extension';").unwrap();
    let expected = fixture.snapshot(1);
    let dependency = fixture.snapshot(3);
    let body = "  approved precise text\n";

    let receipt = fixture.maintain(
        json!({"action":"refine","expected":expected,"content":body}),
        vec![dependency.clone()],
    );

    assert_eq!(receipt["operation"], "organize_maintain");
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["activity_status"], "recorded");
    assert_eq!(
        receipt["organization"]["database"],
        fixture.database.to_str().unwrap()
    );
    let actual = fixture.snapshot(1);
    assert_eq!(actual, receipt["organization"]["records"][0]);
    assert_eq!(actual["content"], body);
    for field in [
        "id",
        "placement",
        "scope",
        "kind",
        "tags",
        "topic_key",
        "created_at",
        "provenance",
    ] {
        assert_eq!(actual[field], expected[field], "{field}");
    }
    assert_ne!(actual["updated_at"], expected["updated_at"]);
    assert_eq!(actual["updated_at"], actual["organized_at"]);
    assert_eq!(fixture.snapshot(3), dependency);
    assert_eq!(
        fixture
            .connection
            .query_row("SELECT extra FROM memories WHERE id=1", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "extension"
    );
    let shown = fixture.history(&receipt);
    assert_eq!(shown.as_array().unwrap().len(), 1);
    assert_eq!(
        shown[0]["detail"]["metadata"],
        json!({"action":"maintain_update","status":"updated","memory_ids":[1],"placements":["universal"]})
    );
    assert_eq!(shown[0]["context"]["session_id"], "maintenance-native");
    assert_eq!(shown[0]["context"]["origin"], "cli");
    assert!(!shown.to_string().contains("approved precise text"));
}

#[test]
fn merge_commits_survivor_and_source_deletions_in_one_producer() {
    let fixture = Fixture::new();
    fixture.connection.execute_batch("INSERT INTO memory_provenance VALUES(1,9,'universal',NULL,NULL,'copy','survivor-origin','created',NULL);
        INSERT INTO memory_provenance VALUES(2,8,'universal',NULL,NULL,'copy','source-origin','created',NULL);").unwrap();
    let survivor = fixture.snapshot(1);
    let sources = vec![fixture.snapshot(2), fixture.snapshot(3)];

    let receipt = fixture.maintain(json!({"action":"merge","survivor":survivor,"sources":sources,"content":"merged conditions retained"}), vec![]);

    assert_eq!(receipt["outcome"], "committed");
    let actual = fixture.snapshot(1);
    assert_eq!(actual, receipt["organization"]["records"][0]);
    assert_eq!(actual["content"], "merged conditions retained");
    assert_eq!(actual["provenance"], survivor["provenance"]);
    assert_eq!(
        receipt["organization"]["deleted"],
        json!([{"id":2,"placement":"universal"},{"id":3,"placement":"universal"}])
    );
    assert!(fixture.snapshot(2).is_null());
    assert!(fixture.snapshot(3).is_null());
    let shown = fixture.history(&receipt);
    assert_eq!(
        shown[0]["detail"]["metadata"],
        json!({"action":"maintain_merge","status":"updated","memory_ids":[1,2,3],"placements":["universal"]})
    );
    let listed = fixture.invoke(
        &[
            "activity",
            "list",
            "--writes",
            "--session",
            "maintenance-native",
            "--json",
        ],
        "",
    );
    assert_eq!(listed["events"], shown);
    assert!(!listed.to_string().contains("merged conditions retained"));
}

#[test]
fn delete_commits_exact_target_and_records_deleted_id() {
    let fixture = Fixture::new();
    let expected = fixture.snapshot(1);
    let dependency = fixture.snapshot(2);

    let receipt = fixture.maintain(
        json!({"action":"delete","expected":expected}),
        vec![dependency.clone()],
    );

    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["organization"]["records"], json!([]));
    assert_eq!(
        receipt["organization"]["deleted"],
        json!([{"id":1,"placement":"universal"}])
    );
    assert!(fixture.snapshot(1).is_null());
    assert_eq!(fixture.snapshot(2), dependency);
    let shown = fixture.history(&receipt);
    assert_eq!(
        shown[0]["detail"]["metadata"],
        json!({"action":"maintain_delete","status":"deleted","memory_ids":[1],"placements":["universal"]})
    );
}

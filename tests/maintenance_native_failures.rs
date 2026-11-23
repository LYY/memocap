#[path = "maintenance_native/support.rs"]
mod support;
use serde_json::json;
use support::Fixture;

#[test]
fn complete_participant_source_and_dependency_conflicts_never_produce_activity() {
    for mutation in [
        "UPDATE memories SET tags='concurrent' WHERE id=1",
        "UPDATE memories SET content='concurrent' WHERE id=2",
        "UPDATE memories SET organized_at='concurrent' WHERE id=3",
        "INSERT INTO memory_provenance VALUES(3,9,'universal',NULL,NULL,'copy','changed-origin','created',NULL)",
    ] {
        let fixture = Fixture::new();
        let survivor = fixture.snapshot(1);
        let source = fixture.snapshot(2);
        let dependency = fixture.snapshot(3);
        fixture.connection.execute_batch(mutation).unwrap();
        let before: Vec<_> = (1..=3).map(|id| fixture.snapshot(id)).collect();

        let receipt = fixture.maintain(json!({"action":"merge","survivor":survivor,"sources":[source],"content":"replacement"}), vec![dependency]);

        assert_eq!(receipt["error"]["code"], "snapshot_conflict");
        assert_eq!(receipt["outcome"], "rolled_back");
        assert_eq!(receipt["activity_status"], "not_requested");
        assert_eq!((1..=3).map(|id| fixture.snapshot(id)).collect::<Vec<_>>(), before);
        assert_eq!(fixture.history(&receipt), json!([]));
    }
}

#[test]
fn transaction_failures_roll_back_survivor_and_prior_deletions_without_activity() {
    for failure in ["ABORT", "ROLLBACK", "IGNORE"] {
        let fixture = Fixture::new();
        fixture.connection.execute_batch(&format!("CREATE TRIGGER fail_merge BEFORE DELETE ON memories WHEN old.id=3 BEGIN SELECT RAISE({failure}{}); END;", if failure == "IGNORE" { "" } else { ",'injected'" })).unwrap();
        let originals: Vec<_> = (1..=3).map(|id| fixture.snapshot(id)).collect();

        let receipt = fixture.maintain(json!({"action":"merge","survivor":originals[0],"sources":[originals[1],originals[2]],"content":"replacement"}), vec![]);

        assert_eq!(receipt["error"]["code"], "database_error");
        assert_eq!(receipt["outcome"], "rolled_back");
        assert_eq!(
            (1..=3).map(|id| fixture.snapshot(id)).collect::<Vec<_>>(),
            originals
        );
        assert_eq!(fixture.history(&receipt), json!([]));
    }
}

#[test]
fn commit_failure_is_rolled_back_and_never_a_successful_maintain_event() {
    let fixture = Fixture::new();
    let expected = fixture.snapshot(1);
    fixture.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; BEGIN; SELECT * FROM memories;").unwrap();

    let receipt = fixture.maintain(
        json!({"action":"refine","expected":expected,"content":"replacement"}),
        vec![],
    );

    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(receipt["status"], "failed");
    assert_eq!(fixture.snapshot(1), expected);
    assert_eq!(fixture.history(&receipt), json!([]));
}

#[test]
fn activity_failure_warns_after_successful_commit_without_replaying_mutation() {
    let fixture = Fixture::new();
    fixture.connection.execute_batch("CREATE TRIGGER fail_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT,'activity unavailable'); END;").unwrap();
    let expected = fixture.snapshot(1);

    let receipt = fixture.maintain(
        json!({"action":"refine","expected":expected,"content":"committed replacement"}),
        vec![],
    );

    assert_eq!(receipt["status"], "ok");
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(receipt["activity_status"], "failed");
    assert!(receipt["warning"]
        .as_str()
        .unwrap()
        .contains("activity unavailable"));
    assert_eq!(fixture.snapshot(1), receipt["organization"]["records"][0]);
    assert_eq!(fixture.snapshot(1)["content"], "committed replacement");
    assert_eq!(fixture.history(&receipt), json!([]));
}

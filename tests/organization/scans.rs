use super::support::*;
use serde_json::json;

#[test]
fn page_uses_raw_global_keysets_after_marking_and_deleting_previous_page() {
    let (_directory, path, connection) = database();
    for number in 1..=45 {
        insert(&connection, &format!("memory {number}"));
    }
    connection.execute_batch("UPDATE memories SET organized_at='done' WHERE id<=5;
        INSERT INTO domains VALUES('unattached','created');
        UPDATE memories SET placement_kind='domain',domain_id='unattached' WHERE id=6;
        UPDATE memories SET placement_kind='repository',repository_id='repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',scope='vanished',topic_key='shadow' WHERE id=7;
        UPDATE memories SET topic_key='shadow' WHERE id=8;").unwrap();
    let first = invoke(&path, "page", &json!({}));
    let page = &first["organization"];
    assert_eq!(page["upper_id"], 45);
    assert_eq!(page["next_id"], 25);
    assert_eq!(page["records"].as_array().unwrap().len(), 20);
    assert_eq!(page["records"][0]["placement"], "domain:unattached");
    assert_eq!(page["records"][1]["scope"], "vanished");
    assert_eq!(page["records"][2]["id"], 8);
    connection.execute_batch("DELETE FROM memories WHERE id<=15; UPDATE memories SET organized_at='done' WHERE id<=25;").unwrap();
    insert(&connection, "outside bound");
    let second = invoke(&path, "page", &json!({"after_id":25,"upper_id":45}));
    assert_eq!(second["organization"]["records"][0]["id"], 26);
    assert_eq!(second["organization"]["next_id"], 45);
    let empty = invoke(&path, "page", &json!({"after_id":45,"upper_id":45}));
    assert_eq!(empty["status"], "empty");
    assert_eq!(empty["organization"]["exhausted"], true);
    assert!(empty["organization"]["next_id"].is_null());
}

#[test]
fn empty_and_reference_streams_have_independent_selection() {
    let (_directory, path, connection) = database();
    let empty = invoke(&path, "page", &json!({}));
    assert_eq!(empty["organization"]["upper_id"], 0);
    insert(&connection, "organized");
    insert(&connection, "pending");
    connection
        .execute("UPDATE memories SET organized_at='done' WHERE id=1", [])
        .unwrap();
    let reference = invoke(
        &path,
        "page",
        &json!({"selection":"organized-reference","upper_id":2}),
    );
    assert_eq!(reference["returned_ids"], json!([1]));
    let all = invoke(&path, "page", &json!({"selection":"all","upper_id":2}));
    assert_eq!(all["returned_ids"], json!([1, 2]));
}

#[test]
fn exact_read_retains_order_null_absence_and_complete_provenance() {
    let (_directory, path, connection) = database();
    insert(&connection, "full content");
    connection.execute_batch("INSERT INTO memory_provenance VALUES(1,9,'universal',NULL,NULL,'copy','op','created',NULL)").unwrap();
    let receipt = invoke(
        &path,
        "read",
        &json!({"keys":[{"id":2,"placement":"universal"},{"id":1,"placement":"domain:other"},{"id":1,"placement":"universal"}]}),
    );
    let records = &receipt["organization"]["records"];
    assert!(records[0]["snapshot"].is_null());
    assert!(records[1]["snapshot"].is_null());
    assert_eq!(records[2]["snapshot"]["provenance"]["source_memory_id"], 9);
    assert!(records[2]["snapshot"]["provenance"]["applicability_note"].is_null());
    assert_eq!(receipt["returned_ids"], json!([1]));
}

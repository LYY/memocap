#[path = "support/receipt_server.rs"]
#[expect(dead_code, reason = "Shared fixture also covers remote failure modes.")]
mod receipt_server;
#[path = "support/observable.rs"]
mod support;

use memocap::{discovery::Discovery, remote, store::MatchMode};
use serde_json::{json, Value};
use support::Fixture;

#[test]
fn chinese_substrings_and_paraphrases_reach_native_json_and_remote() {
    let fixture = Fixture::new();
    let saved = fixture.json(&["remember", "数据库变更必须保留用户数据", "--json"], true);
    for query in ["数据库", "数据库迁移有什么要求"] {
        let receipt = fixture.json(&["recall", query, "--json"], true);
        assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
        let plain = fixture.command(&["recall", query]).output().unwrap();
        assert!(plain.status.success());
        assert!(String::from_utf8_lossy(&plain.stdout).contains("数据库变更必须保留用户数据"));
    }
    let (address, worker) =
        receipt_server::start(fixture.database.clone(), receipt_server::Mode::Normal, 6);
    for query in ["数据库", "数据库迁移有什么要求"] {
        let output = fixture
            .command(&["recall", query, "--json"])
            .env("MEMOCAP_ADDR", &address)
            .env("MEMOCAP_TOKEN", "receipt-test-token")
            .output()
            .unwrap();
        assert!(output.status.success());
        let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
        let scope = memocap::scope::resolve_readonly(&fixture.a).unwrap();
        let memories = remote::recall(
            &address,
            "receipt-test-token",
            remote::RecallRequest {
                repository: scope.repository(),
                discovery: &Discovery::Library,
                match_mode: MatchMode::All,
                query,
                limit: 3,
                kind: None,
                max_chars: Some(6000),
            },
        )
        .unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(json!(memories[0].memory.id), saved["returned_ids"][0]);
    }
    assert!(matches!(
        worker.join().termination,
        receipt_server::Termination::Completed
    ));
}

#[test]
fn mixed_query_keeps_all_and_any_term_semantics() {
    let fixture = Fixture::new();
    let sqlite = fixture.json(&["remember", "SQLite 数据库变更需要备份", "--json"], true);
    fixture.json(&["remember", "Postgres 数据库维护窗口", "--json"], true);
    let all = fixture.json(&["recall", "SQLite 数据库迁移", "--json"], true);
    assert_eq!(all["returned_ids"], sqlite["returned_ids"]);
    let any = fixture.json(
        &["recall", "SQLite 数据库迁移", "--match", "any", "--json"],
        true,
    );
    assert_eq!(any["returned_ids"].as_array().unwrap().len(), 2);
    let absent = fixture.json(&["recall", "MySQL 数据库迁移", "--json"], true);
    assert_eq!(absent["returned_ids"], json!([]));
}

#[test]
fn empty_punctuation_and_unrelated_queries_do_not_become_match_all() {
    let fixture = Fixture::new();
    fixture.json(&["remember", "数据库变更必须保留用户数据", "--json"], true);
    for query in ["", "  ", "\"\"", "! /", "彗星观测", "data"] {
        let receipt = fixture.json(&["recall", query, "--json"], true);
        assert_eq!(receipt["returned_ids"], json!([]), "{query}");
    }
}

#[test]
fn english_and_precise_long_path_anchors_remain_exact() {
    let fixture = Fixture::new();
    let path = "/synthetic/orbit/very/long/component/ops/entry.yaml";
    let saved = fixture.json(&["remember", &format!("Deployment {path}"), "--json"], true);
    fixture.json(
        &[
            "remember",
            "Deployment /synthetic/orbit/other/entry.yaml",
            "--json",
        ],
        true,
    );
    let receipt = fixture.json(&["recall", path, "--json"], true);
    assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
    let english = fixture.json(&["recall", "Deployment", "--json"], true);
    assert_eq!(english["returned_ids"].as_array().unwrap().len(), 2);
}

#[test]
fn lexical_discovery_respects_kind_placements_and_one_global_budget() {
    let fixture = Fixture::new();
    fixture.json(
        &["remember", "数据库维护说明", "--type", "context", "--json"],
        true,
    );
    let saved = fixture.json(
        &[
            "remember",
            "数据库变更规则",
            "--type",
            "decision",
            "--universal",
            "--json",
        ],
        true,
    );
    fixture.json(
        &[
            "--repo",
            fixture.b.to_str().unwrap(),
            "remember",
            "数据库异地记录",
            "--json",
        ],
        true,
    );
    let selected = fixture.json(
        &[
            "recall",
            "数据库",
            "--universal",
            "--type",
            "decision",
            "--json",
        ],
        true,
    );
    assert_eq!(selected["returned_ids"], saved["returned_ids"]);
    let limited = fixture.json(
        &[
            "recall",
            "数据库",
            "--limit",
            "1",
            "--max-chars",
            "1",
            "--json",
        ],
        true,
    );
    assert_eq!(limited["matched_ids"].as_array().unwrap().len(), 3);
    assert_eq!(limited["returned_ids"], json!([]));
    assert_eq!(limited["truncated"], true);
}

#[test]
fn overwritten_and_deleted_content_cannot_supply_stale_lexical_matches() {
    let fixture = Fixture::new();
    let saved = fixture.json(&["remember", "数据库变更必须保留用户数据", "--json"], true);
    let id = saved["returned_ids"][0].to_string();
    fixture.json(
        &[
            "remember",
            "证书续期必须核对签发机构",
            "--id",
            &id,
            "--json",
        ],
        true,
    );
    assert_eq!(
        fixture.json(&["recall", "数据库", "--json"], true)["returned_ids"],
        json!([])
    );
    assert_eq!(
        fixture.json(&["recall", "证书", "--json"], true)["returned_ids"],
        saved["returned_ids"]
    );
    fixture.json(&["forget", &id, "--json"], true);
    assert_eq!(
        fixture.json(&["recall", "证书", "--json"], true)["returned_ids"],
        json!([])
    );
}

#[test]
fn exact_chinese_sentence_is_not_displaced_by_repeated_two_character_overlap() {
    let fixture = Fixture::new();
    let saved = fixture.json(&["remember", "数据库变更必须保留用户数据", "--json"], true);
    let distractor = "必须先读全文核对环境。".repeat(380);
    fixture.json(&["remember", &distractor, "--json"], true);
    let receipt = fixture.json(&["recall", "数据库变更必须保留用户数据", "--json"], true);
    assert_eq!(receipt["returned_ids"], saved["returned_ids"]);
}

#[test]
fn glued_latin_anchor_and_chinese_tags_are_preserved() {
    let fixture = Fixture::new();
    let saved = fixture.json(
        &[
            "remember",
            "SQLite数据库维护规则",
            "--tags",
            "证书续期指南",
            "--json",
        ],
        true,
    );
    fixture.json(&["remember", "Postgres数据库维护规则", "--json"], true);
    let mixed = fixture.json(&["recall", "sqlite数据库迁移", "--json"], true);
    assert_eq!(mixed["returned_ids"], saved["returned_ids"]);
    let tags = fixture.json(&["recall", "证书", "--json"], true);
    assert_eq!(tags["returned_ids"], saved["returned_ids"]);
}

#[test]
fn lexical_expansion_works_on_existing_schema_with_read_only_connection() {
    let fixture = Fixture::new();
    let saved = fixture.json(&["remember", "数据库变更必须保留用户数据", "--json"], true);
    let connection =
        memocap::store::open_strict_readonly(&fixture.database, std::time::Duration::from_secs(5))
            .unwrap();
    let memories = memocap::store::recall_discovery(
        &connection,
        &Discovery::Library,
        memocap::store::RecallOptions {
            query: "数据库迁移有什么要求",
            kind: None,
            match_mode: MatchMode::All,
            limit: 3,
            max_chars: Some(6000),
        },
    )
    .unwrap();
    assert_eq!(json!(memories[0].memory.id), saved["returned_ids"][0]);
}

#[test]
fn excessive_expansion_is_an_error_rather_than_a_partial_or_match_all_result() {
    let fixture = Fixture::new();
    let content = (0..256)
        .map(|index| format!("数据库条目{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    fixture.json(&["remember", &content, "--json"], true);
    let receipt = fixture.json(&["recall", "数据库", "--json"], false);
    assert_eq!(receipt["status"], "failed");
    assert_eq!(receipt["returned_ids"], json!([]));
}

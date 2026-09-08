use memocap::scope::ScopeId;
use memocap::store;

fn scope_id(seed: char) -> ScopeId {
    format!("scope:v1:{}", seed.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn remember_scoped(
    connection: &rusqlite::Connection,
    scope: &ScopeId,
    content: &str,
    topic_key: Option<&str>,
    force: bool,
    overwrite_id: Option<i64>,
) -> anyhow::Result<i64> {
    store::remember_scoped(
        connection,
        scope,
        content,
        "note",
        "",
        store::RememberOptions {
            topic_key,
            force,
            overwrite_id,
        },
    )
}

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn save() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "alpha", "note", "t1", "global", false, None).unwrap();
    assert!(id > 0);
    assert_eq!(store::count(&c).unwrap(), 1);
}

#[test]
fn query() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let found = store::recall(&c, "alpha", 5, None, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, "note");
}

#[test]
fn list_newest() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let a = store::remember(&c, "first", "note", "", "global", false, None).unwrap();
    let b = store::remember(&c, "second", "note", "", "global", false, None).unwrap();
    let listed = store::list(&c, 20).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, b);
    assert_eq!(listed[1].id, a);
}

#[test]
fn delete_target() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let keep = store::remember(&c, "keep", "note", "", "global", false, None).unwrap();
    let drop = store::remember(&c, "drop", "note", "", "global", false, None).unwrap();
    assert!(store::forget(&c, drop).unwrap());
    assert!(!store::forget(&c, drop).unwrap());
    let listed = store::list(&c, 20).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, keep);
}

#[test]
fn empty_store() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    assert!(store::list(&c, 20).unwrap().is_empty());
    assert_eq!(store::count(&c).unwrap(), 0);
}

#[test]
fn no_result() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "only rust sqlite", "note", "", "global", false, None).unwrap();
    assert!(store::recall(&c, "python chroma", 5, None, None)
        .unwrap()
        .is_empty());
    assert!(store::recall(&c, "   ", 5, None, None).unwrap().is_empty());
}

#[test]
fn similar_skips_insert_without_force() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let err = store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap_err();
    let similar = err.downcast_ref::<store::SimilarMemories>().unwrap();
    assert_eq!(similar.candidates.len(), 1);
    assert_eq!(similar.candidates[0].id, id);
    assert_eq!(similar.candidates[0].content, "alpha beta");
    assert!(err.to_string().contains("pass --force"));
    assert_eq!(store::count(&c).unwrap(), 1);
}

#[test]
fn force_inserts_anyway() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let id = store::remember(&c, "alpha beta", "note", "", "global", true, None).unwrap();
    assert!(id > 0);
    assert_eq!(store::count(&c).unwrap(), 2);
}

#[test]
fn recall_default_limit_is_three() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    for _ in 0..5 {
        store::remember(&c, "shared token", "note", "", "global", true, None).unwrap();
    }
    assert_eq!(store::DEFAULT_RECALL_LIMIT, 3);
    let found = store::recall(&c, "shared token", store::DEFAULT_RECALL_LIMIT, None, None).unwrap();
    assert_eq!(found.len(), 3);
}

#[test]
fn recall_kind_filter() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha note item", "note", "", "global", false, None).unwrap();
    store::remember(
        &c,
        "alpha pref item",
        "preference",
        "",
        "global",
        false,
        None,
    )
    .unwrap();
    let notes = store::recall(&c, "alpha", 10, Some("note"), None).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].kind, "note");
    let prefs = store::recall(&c, "alpha", 10, Some("preference"), None).unwrap();
    assert_eq!(prefs.len(), 1);
    assert_eq!(prefs[0].kind, "preference");
}

#[test]
fn overwrite_by_id() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "old", "note", "", "global", false, None).unwrap();
    let saved = store::remember(&c, "new", "note", "t", "global", false, Some(id)).unwrap();
    assert_eq!(saved, id);
    assert_eq!(store::count(&c).unwrap(), 1);
    assert_eq!(store::list(&c, 20).unwrap()[0].content, "new");
}

#[test]
fn scopes_isolate_records_while_preserving_global_visibility() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    let beta = scope_id('b');
    let global_id = remember_scoped(&c, &global, "shared global record", None, true, None).unwrap();
    let alpha_id = remember_scoped(&c, &alpha, "same content", None, false, None).unwrap();
    let beta_id = remember_scoped(&c, &beta, "same content", None, false, None).unwrap();

    // When
    let alpha_list = store::list_scoped(&c, &alpha, 20).unwrap();
    let beta_list = store::list_scoped(&c, &beta, 20).unwrap();
    let alpha_recall = store::recall_scoped(&c, &alpha, "content", 20, None, None).unwrap();
    let beta_recall = store::recall_scoped(&c, &beta, "content", 20, None, None).unwrap();

    // Then
    assert_eq!(
        alpha_list
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![alpha_id, global_id]
    );
    assert_eq!(
        beta_list.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        vec![beta_id, global_id]
    );
    assert_eq!(
        alpha_recall
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![alpha_id]
    );
    assert_eq!(
        beta_recall
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![beta_id]
    );
    assert_eq!(store::count_scoped(&c, &alpha).unwrap(), 2);
    assert_eq!(store::count_scoped(&c, &beta).unwrap(), 2);
    assert_eq!(store::count_scoped(&c, &global).unwrap(), 1);
}

#[test]
fn scoped_duplicate_and_destructive_operations_cannot_cross_scope() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let alpha = scope_id('a');
    let beta = scope_id('b');
    let alpha_id = remember_scoped(&c, &alpha, "same content", None, false, None).unwrap();
    let beta_id = remember_scoped(&c, &beta, "same content", None, false, None).unwrap();

    // When
    let duplicate = remember_scoped(&c, &beta, "same content", None, false, None).unwrap_err();
    let overwrite = remember_scoped(&c, &beta, "changed", None, true, Some(alpha_id));
    let deleted = store::forget_scoped(&c, &beta, alpha_id).unwrap();

    // Then
    assert_eq!(
        duplicate
            .downcast_ref::<store::SimilarMemories>()
            .unwrap()
            .candidates
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![beta_id]
    );
    assert!(overwrite.is_err());
    assert!(!deleted);
    assert_eq!(
        store::list_scoped(&c, &alpha, 20).unwrap()[0].content,
        "same content"
    );
}

#[test]
fn recall_shadows_global_topics_before_limit_and_character_budget() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    let global_id = remember_scoped(
        &c,
        &global,
        "global result with many characters",
        Some(" status "),
        true,
        None,
    )
    .unwrap();
    let alpha_id = remember_scoped(&c, &alpha, "local result", Some("status"), true, None).unwrap();
    remember_scoped(&c, &global, "unkeyed global result", None, true, None).unwrap();

    // When
    let recalled = store::recall_scoped(&c, &alpha, "result", 1, None, Some(12)).unwrap();
    let all_recalled = store::recall_scoped(&c, &alpha, "result", 20, None, None).unwrap();
    let listed = store::list_scoped(&c, &alpha, 20).unwrap();

    // Then
    assert_eq!(
        recalled.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        vec![alpha_id]
    );
    assert_eq!(recalled[0].topic_key, "status");
    assert!(!all_recalled.iter().any(|memory| memory.id == global_id));
    assert!(listed.iter().any(|memory| memory.id == global_id));
    assert_eq!(store::count_scoped(&c, &alpha).unwrap(), 3);
}

#[test]
fn topic_key_normalizes_unicode_whitespace_and_case() {
    let topic = "\u{2003}RÜST\u{00A0}\tİSTANBUL\u{3000} Σ\u{2002}";

    assert_eq!(
        store::normalize_topic_key(Some(topic)).as_deref(),
        Some("rüst i\u{0307}stanbul σ")
    );
}

#[test]
fn unicode_equivalent_scoped_topic_shadows_global_recall() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let repository = scope_id('a');
    let global_id = remember_scoped(
        &c,
        &global,
        "global unicode topic result",
        Some("\u{2003}RÜST\u{00A0}\tİSTANBUL\u{3000} Σ\u{2002}"),
        true,
        None,
    )
    .unwrap();
    let repository_id = remember_scoped(
        &c,
        &repository,
        "repository unicode topic result",
        Some("rüst i\u{0307}stanbul σ"),
        true,
        None,
    )
    .unwrap();

    let recalled = store::recall_scoped(&c, &repository, "result", 20, None, None).unwrap();

    assert!(recalled.iter().any(|memory| memory.id == repository_id));
    assert!(!recalled.iter().any(|memory| memory.id == global_id));
}

#[test]
fn empty_topics_do_not_shadow_and_overwrite_preserves_or_clears_topic() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    remember_scoped(&c, &global, "global result", Some("topic"), true, None).unwrap();
    let id = remember_scoped(&c, &alpha, "local result", Some("topic"), true, None).unwrap();
    remember_scoped(&c, &alpha, "local unkeyed result", Some("  "), true, None).unwrap();

    // When
    remember_scoped(&c, &alpha, "local updated result", None, true, Some(id)).unwrap();
    let preserved = store::list_scoped(&c, &alpha, 20).unwrap();
    remember_scoped(
        &c,
        &alpha,
        "local cleared result",
        Some("  "),
        true,
        Some(id),
    )
    .unwrap();
    let recalled = store::recall_scoped(&c, &alpha, "result", 20, None, None).unwrap();

    // Then
    assert_eq!(
        preserved
            .iter()
            .find(|memory| memory.id == id)
            .unwrap()
            .topic_key,
        "topic"
    );
    assert_eq!(
        recalled
            .iter()
            .filter(|memory| memory.topic_key == "topic")
            .count(),
        1
    );
    assert!(recalled
        .iter()
        .any(|memory| memory.id == id && memory.topic_key.is_empty()));
}

#[test]
fn open_migrates_legacy_topic_column_without_breaking_fts() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let legacy = rusqlite::Connection::open(&database).unwrap();
    legacy
        .execute_batch(
            "
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY,
                content TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'context',
                tags TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'global'
            );
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                content, tags, content='memories', content_rowid='id'
            );
            CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
            END;
            INSERT INTO memories (id, content, kind, tags, created_at, updated_at, scope)
            VALUES (7, 'legacy searchable value', 'note', '', 'before', 'before', 'global');
            ",
        )
        .unwrap();
    drop(legacy);

    // When
    let c = store::open(&database).unwrap();
    let columns = c
        .prepare("PRAGMA table_info(memories)")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let found = store::recall_scoped(&c, &ScopeId::global(), "searchable", 5, None, None).unwrap();
    drop(c);
    let reopened = store::open(&database).unwrap();

    // Then
    assert!(columns.iter().any(|column| column.0 == "topic_key"));
    assert_eq!(
        columns
            .iter()
            .find(|column| column.0 == "topic_key")
            .unwrap(),
        &(
            "topic_key".to_owned(),
            "TEXT".to_owned(),
            1,
            Some("''".to_owned())
        )
    );
    assert_eq!(found[0].id, 7);
    assert_eq!(found[0].topic_key, "");
    assert_eq!(
        store::list_scoped(&reopened, &ScopeId::global(), 20).unwrap()[0].content,
        "legacy searchable value"
    );
}

#[test]
fn scope_migration_counts_dry_runs_and_rolls_back_batch_failures() {
    // Given
    let d = dir();
    let mut c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    let first = remember_scoped(&c, &global, "first", None, true, None).unwrap();
    remember_scoped(&c, &global, "second", None, true, None).unwrap();
    let before_failure = store::list_scoped(&c, &global, 20)
        .unwrap()
        .iter()
        .map(|memory| {
            (
                memory.id,
                memory.content.clone(),
                memory.created_at.clone(),
                memory.updated_at.clone(),
                memory.scope.clone(),
            )
        })
        .collect::<Vec<_>>();
    c.execute(
        "CREATE TRIGGER fail_second_move BEFORE UPDATE OF scope ON memories
         WHEN old.content = 'second' BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END",
        [],
    )
    .unwrap();

    // When
    let count = store::scope_migration_count(&c, &global, store::ScopeMigration::All).unwrap();
    let dry_run = store::migrate_scope(
        &mut c,
        &global,
        &alpha,
        store::ScopeMigration::One(first),
        true,
    )
    .unwrap();
    let failed = store::migrate_scope(&mut c, &global, &alpha, store::ScopeMigration::All, false);

    // Then
    assert_eq!(count, 2);
    assert_eq!(dry_run, 1);
    assert!(failed.is_err());
    let after_failure = store::list_scoped(&c, &global, 20)
        .unwrap()
        .iter()
        .map(|memory| {
            (
                memory.id,
                memory.content.clone(),
                memory.created_at.clone(),
                memory.updated_at.clone(),
                memory.scope.clone(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(after_failure, before_failure);
    c.execute("DROP TRIGGER fail_second_move", []).unwrap();
    assert_eq!(
        store::migrate_scope(
            &mut c,
            &global,
            &alpha,
            store::ScopeMigration::One(first),
            false,
        )
        .unwrap(),
        1
    );
    assert_eq!(
        store::migrate_scope(&mut c, &global, &alpha, store::ScopeMigration::All, false).unwrap(),
        1
    );
    assert!(store::list_scoped(&c, &alpha, 20)
        .unwrap()
        .iter()
        .all(|memory| memory.scope == alpha.as_str()));
    assert!(
        store::migrate_scope(&mut c, &global, &global, store::ScopeMigration::All, true).is_err()
    );
}

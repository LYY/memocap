use memocap::store;

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

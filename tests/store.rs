use memocap::store;

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn save() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "alpha", "note", "t1", "global").unwrap();
    assert!(id > 0);
    assert_eq!(store::count(&c).unwrap(), 1);
}

#[test]
fn query() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha beta", "note", "", "global").unwrap();
    let found = store::recall(&c, "alpha", 5).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, "note");
}

#[test]
fn list_newest() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let a = store::remember(&c, "first", "note", "", "global").unwrap();
    let b = store::remember(&c, "second", "note", "", "global").unwrap();
    let listed = store::list(&c, 20).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, b);
    assert_eq!(listed[1].id, a);
}

#[test]
fn delete_target() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let keep = store::remember(&c, "keep", "note", "", "global").unwrap();
    let drop = store::remember(&c, "drop", "note", "", "global").unwrap();
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
    store::remember(&c, "only rust sqlite", "note", "", "global").unwrap();
    assert!(store::recall(&c, "python chroma", 5).unwrap().is_empty());
    assert!(store::recall(&c, "   ", 5).unwrap().is_empty());
}

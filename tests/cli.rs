use memocap::cli;
use std::path::PathBuf;

fn db() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("db");
    (d, p)
}

#[test]
fn save() {
    let (_d, db) = db();
    let id = cli::remember(&db, "alpha", "note", "t1").unwrap();
    assert!(id > 0);
    assert_eq!(cli::count(&db).unwrap(), 1);
}

#[test]
fn query() {
    let (_d, db) = db();
    cli::remember(&db, "alpha beta", "note", "").unwrap();
    let found = cli::recall(&db, "alpha", 5).unwrap();
    assert_eq!(found.len(), 1);
}

#[test]
fn list_newest() {
    let (_d, db) = db();
    let a = cli::remember(&db, "first", "note", "").unwrap();
    let b = cli::remember(&db, "second", "note", "").unwrap();
    let listed = cli::list(&db, 20).unwrap();
    assert_eq!(listed[0].id, b);
    assert_eq!(listed[1].id, a);
}

#[test]
fn delete_target() {
    let (_d, db) = db();
    let keep = cli::remember(&db, "keep", "note", "").unwrap();
    let drop = cli::remember(&db, "drop", "note", "").unwrap();
    assert!(cli::forget(&db, drop).unwrap());
    assert_eq!(cli::list(&db, 20).unwrap()[0].id, keep);
}

#[test]
fn empty_store() {
    let (_d, db) = db();
    let listed = cli::list(&db, 20).unwrap();
    assert!(listed.is_empty());
    assert_eq!(cli::format_memories(&listed), "No local memories found.\n");
    assert_eq!(cli::count(&db).unwrap(), 0);
}

#[test]
fn no_result() {
    let (_d, db) = db();
    cli::remember(&db, "only rust sqlite", "note", "").unwrap();
    let found = cli::recall(&db, "python chroma", 5).unwrap();
    assert!(found.is_empty());
    assert_eq!(cli::format_memories(&found), "No local memories found.\n");
}

use memocap::{
    scope::{DomainId, RepositoryId},
    store,
};
use rusqlite::params;

fn repository(seed: char) -> RepositoryId {
    format!("repository:{}", seed.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn domain(value: &str) -> DomainId {
    value.parse().unwrap()
}

fn database() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memocap.db");
    (directory, path)
}

#[test]
fn create_domain_is_idempotent_and_registry_list_is_sorted() {
    // Given
    let (_directory, path) = database();
    let mut connection = store::open(&path).unwrap();
    let rust = domain("platform/rust");
    let sqlite = domain("platform/sqlite");

    // When
    let created_rust = store::create_domain(&mut connection, &rust).unwrap();
    let created_sqlite = store::create_domain(&mut connection, &sqlite).unwrap();
    let created_rust_again = store::create_domain(&mut connection, &rust).unwrap();
    let domains = store::domains(&connection).unwrap();

    // Then
    assert!(created_rust);
    assert!(created_sqlite);
    assert!(!created_rust_again);
    assert_eq!(
        domains.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["platform/rust", "platform/sqlite"]
    );
}

#[test]
fn delete_unused_domain_removes_only_its_registry_entry() {
    // Given
    let (_directory, path) = database();
    let mut connection = store::open(&path).unwrap();
    let obsolete = domain("platform/obsolete");
    let retained = domain("platform/retained");
    store::create_domain(&mut connection, &obsolete).unwrap();
    store::create_domain(&mut connection, &retained).unwrap();

    // When
    let deleted = store::delete_domain(&mut connection, &obsolete).unwrap();
    let domains = store::domains(&connection).unwrap();

    // Then
    assert!(deleted);
    assert_eq!(
        domains.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["platform/retained"]
    );
}

#[test]
fn delete_in_use_domain_rejects_before_mutating_attachments_or_memories() {
    // Given
    let (_directory, path) = database();
    let mut connection = store::open(&path).unwrap();
    let attached = domain("platform/attached");
    let memory_backed = domain("platform/memory-backed");
    let repository = repository('a');
    store::create_domain(&mut connection, &attached).unwrap();
    store::create_domain(&mut connection, &memory_backed).unwrap();
    store::attach_domain(&mut connection, &repository, &attached, None).unwrap();
    connection
        .execute(
            "INSERT INTO memories (
                content, kind, tags, created_at, updated_at, scope, topic_key, placement_kind, domain_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                "domain-owned sentinel",
                "note",
                "",
                "before",
                "before",
                "global",
                "",
                "domain",
                memory_backed.as_str(),
            ],
        )
        .unwrap();

    // When
    let attached_error = store::delete_domain(&mut connection, &attached).unwrap_err();
    let memory_error = store::delete_domain(&mut connection, &memory_backed).unwrap_err();

    // Then
    assert!(attached_error.to_string().contains("attachment"));
    assert!(memory_error.to_string().contains("memory"));
    assert_eq!(
        store::attached_domains(&connection, &repository)
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["platform/attached"]
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE domain_id = ?1",
                [memory_backed.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
}

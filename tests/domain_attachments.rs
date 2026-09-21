use memocap::{
    scope::{DomainId, RepositoryId},
    store,
};

fn repository(seed: char) -> RepositoryId {
    format!("repository:{}", seed.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn domain(value: &str) -> DomainId {
    value.parse().unwrap()
}

fn attached(connection: &rusqlite::Connection, repository: &RepositoryId) -> Vec<String> {
    store::attached_domains(connection, repository)
        .unwrap()
        .iter()
        .map(ToString::to_string)
        .collect()
}

#[test]
fn attach_before_persists_exact_order_across_reopen_and_duplicate_attach_is_a_noop() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memocap.db");
    let mut connection = store::open(&path).unwrap();
    let repository = repository('a');
    let rust = domain("platform/rust");
    let sqlite = domain("platform/sqlite");
    let ops = domain("platform/ops");
    for value in [&rust, &sqlite, &ops] {
        store::create_domain(&mut connection, value).unwrap();
    }

    // When
    assert!(store::attach_domain(&mut connection, &repository, &rust, None).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &sqlite, Some(&rust)).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &ops, Some(&rust)).unwrap());
    assert!(!store::attach_domain(&mut connection, &repository, &sqlite, Some(&rust)).unwrap());
    drop(connection);
    let reopened = store::open(&path).unwrap();

    // Then
    assert_eq!(
        attached(&reopened, &repository),
        ["platform/sqlite", "platform/ops", "platform/rust"]
    );
    let raw = reopened
        .prepare(
            "SELECT domain_id, position
             FROM repository_domain_attachments
             WHERE repository_id = ?1
             ORDER BY position",
        )
        .unwrap()
        .query_map([repository.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        raw,
        [
            ("platform/sqlite".to_owned(), 0),
            ("platform/ops".to_owned(), 1),
            ("platform/rust".to_owned(), 2),
        ]
    );
}

#[test]
fn attach_rejects_missing_reference_and_rolls_back_position_changes() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let repository = repository('a');
    let rust = domain("platform/rust");
    let sqlite = domain("platform/sqlite");
    let ops = domain("platform/ops");
    for value in [&rust, &sqlite, &ops] {
        store::create_domain(&mut connection, value).unwrap();
    }
    store::attach_domain(&mut connection, &repository, &rust, None).unwrap();
    let initial = attached(&connection, &repository);

    // When
    let missing_reference = store::attach_domain(&mut connection, &repository, &sqlite, Some(&ops));
    connection
        .execute_batch(
            "CREATE TRIGGER abort_attachment
             BEFORE INSERT ON repository_domain_attachments
             BEGIN SELECT RAISE(ABORT, 'injected attachment failure'); END;",
        )
        .unwrap();
    let rolled_back = store::attach_domain(&mut connection, &repository, &sqlite, Some(&rust));

    // Then
    assert!(missing_reference.is_err());
    assert!(rolled_back.is_err());
    assert_eq!(attached(&connection, &repository), initial);
}

#[test]
fn detach_removes_only_the_current_repository_binding() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let alpha = repository('a');
    let beta = repository('b');
    let rust = domain("platform/rust");
    store::create_domain(&mut connection, &rust).unwrap();
    store::attach_domain(&mut connection, &alpha, &rust, None).unwrap();
    store::attach_domain(&mut connection, &beta, &rust, None).unwrap();

    // When
    let detached = store::detach_domain(&mut connection, &alpha, &rust).unwrap();

    // Then
    assert!(detached);
    assert!(attached(&connection, &alpha).is_empty());
    assert_eq!(attached(&connection, &beta), ["platform/rust"]);
}

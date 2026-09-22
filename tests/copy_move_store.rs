use memocap::{
    scope::{DomainId, OperationId, PlacementId, RepositoryId},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest, RememberOptions},
};

#[path = "copy_move_store/validation_matrix.rs"]
mod validation_matrix;

fn repository() -> RepositoryId {
    format!("repository:{}", "a".repeat(64)).parse().unwrap()
}

fn other_repository() -> RepositoryId {
    format!("repository:{}", "b".repeat(64)).parse().unwrap()
}

fn operation_id(value: &str) -> OperationId {
    value.parse().unwrap()
}

fn domain(value: &str) -> DomainId {
    value.parse().unwrap()
}

fn remember_source(connection: &rusqlite::Connection, placement: &PlacementId) -> i64 {
    store::remember_at(
        connection,
        placement,
        "source content",
        "decision",
        "transfer",
        RememberOptions {
            topic_key: Some("transfer-topic"),
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap()
}

#[test]
fn copy_replays_serialized_success_after_reopen_without_duplicate_mutation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let destination = PlacementId::Universal;
    let mut connection = store::open(&database).unwrap();
    let source_id = remember_source(&connection, &source);
    let input = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source.clone(),
        to: destination.clone(),
        operation_id: Some(operation_id("00000000-0000-0000-0000-000000000001")),
        applicability_note: Some("portable decision".to_owned()),
    };
    let request = CopyMoveRequest::prepare(repository.clone(), input.clone()).unwrap();

    // When
    let copied = store::copy_move(&mut connection, request).unwrap();
    drop(connection);
    let mut reopened = store::open(&database).unwrap();
    let replayed = store::copy_move(
        &mut reopened,
        CopyMoveRequest::prepare(repository.clone(), input).unwrap(),
    )
    .unwrap();

    // Then
    assert_ne!(copied.memory_id, source_id);
    assert_eq!(copied, replayed);
    assert_eq!(copied.action, CopyMoveAction::Copy);
    assert_eq!(copied.from, source);
    assert_eq!(copied.to, destination);
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    let provenance = reopened
        .query_row(
            "SELECT source_memory_id, source_placement_kind, action, operation_id, applicability_note
             FROM memory_provenance WHERE memory_id = ?1",
            [copied.memory_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        provenance,
        (
            source_id,
            "repository".to_owned(),
            "copy".to_owned(),
            "00000000-0000-0000-0000-000000000001".to_owned(),
            Some("portable decision".to_owned()),
        )
    );
    let ledger = reopened
        .query_row(
            "SELECT request_fingerprint, mutation, result_json FROM operation_ledger",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(ledger.0.len(), 64);
    assert!(ledger
        .0
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()));
    let mutation: serde_json::Value = serde_json::from_str(&ledger.1).unwrap();
    assert_eq!(mutation["action"], "copy");
    assert_eq!(mutation["memory_id"], source_id);
    let result: serde_json::Value = serde_json::from_str(&ledger.2).unwrap();
    assert_eq!(result["memory_id"], copied.memory_id);
}

#[test]
fn move_retains_memory_id_and_replays_after_source_placement_changes() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let destination = PlacementId::Universal;
    let mut connection = store::open(&database).unwrap();
    let source_id = remember_source(&connection, &source);
    let input = CopyMoveInput {
        action: CopyMoveAction::Move,
        memory_id: source_id,
        from: source.clone(),
        to: destination.clone(),
        operation_id: Some(operation_id("00000000-0000-0000-0000-000000000002")),
        applicability_note: None,
    };

    // When
    let moved = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository.clone(), input.clone()).unwrap(),
    )
    .unwrap();
    let replayed = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, input).unwrap(),
    )
    .unwrap();

    // Then
    assert_eq!(moved.memory_id, source_id);
    assert_eq!(moved, replayed);
    assert_eq!(
        connection
            .query_row(
                "SELECT placement_kind FROM memories WHERE id = ?1",
                [source_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "universal"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT action FROM memory_provenance WHERE memory_id = ?1",
                [source_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "move"
    );
}

#[test]
fn changed_fingerprint_for_existing_operation_id_conflicts_without_mutation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let source_id = remember_source(&connection, &source);
    let operation_id = operation_id("00000000-0000-0000-0000-000000000003");
    let copy = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source.clone(),
        to: PlacementId::Universal,
        operation_id: Some(operation_id.clone()),
        applicability_note: None,
    };
    store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository.clone(), copy).unwrap(),
    )
    .unwrap();
    let changed = CopyMoveInput {
        action: CopyMoveAction::Move,
        memory_id: source_id,
        from: source,
        to: PlacementId::Universal,
        operation_id: Some(operation_id),
        applicability_note: None,
    };

    // When
    let failure = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, changed).unwrap(),
    );

    // Then
    assert!(failure
        .unwrap_err()
        .to_string()
        .contains("operation ID conflict"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn copy_rejects_the_same_source_and_destination_without_mutation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let source_id = remember_source(&connection, &source);
    let input = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source.clone(),
        to: source,
        operation_id: Some(operation_id("00000000-0000-0000-0000-000000000005")),
        applicability_note: None,
    };

    // When
    let failure = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, input).unwrap(),
    );

    // Then
    assert!(failure
        .unwrap_err()
        .to_string()
        .contains("source and destination placements must differ"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn transaction_failure_rolls_back_memory_provenance_and_ledger_after_reopen() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let mut connection = store::open(&database).unwrap();
    let source_id = remember_source(&connection, &source);
    connection
        .execute_batch(
            "CREATE TRIGGER fail_ledger BEFORE INSERT ON operation_ledger
             BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END;",
        )
        .unwrap();
    let input = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source,
        to: PlacementId::Universal,
        operation_id: Some(operation_id("00000000-0000-0000-0000-000000000004")),
        applicability_note: None,
    };

    // When
    let failure = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, input).unwrap(),
    );
    connection.execute("DROP TRIGGER fail_ledger", []).unwrap();
    drop(connection);
    let reopened = store::open(&database).unwrap();

    // Then
    assert!(failure.is_err());
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn copy_rejects_detached_destination_before_mutating_store() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let destination = domain("transfer/detached-destination");
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let source_id = remember_source(&connection, &source);
    assert!(store::create_domain(&mut connection, &destination).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &destination, None).unwrap());
    assert!(store::detach_domain(&mut connection, &repository, &destination).unwrap());
    let request = CopyMoveRequest::prepare(
        repository,
        CopyMoveInput {
            action: CopyMoveAction::Copy,
            memory_id: source_id,
            from: source,
            to: PlacementId::Domain(destination),
            operation_id: Some(operation_id("00000000-0000-0000-0000-000000000006")),
            applicability_note: None,
        },
    )
    .unwrap();

    // When
    let failure = store::copy_move(&mut connection, request);

    // Then
    assert!(failure
        .unwrap_err()
        .to_string()
        .contains("is not attached to this repository"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn move_rejects_detached_source_without_provenance_or_ledger() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let source_domain = domain("transfer/detached-source");
    let source = PlacementId::Domain(source_domain.clone());
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    assert!(store::create_domain(&mut connection, &source_domain).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &source_domain, None).unwrap());
    let source_id = remember_source(&connection, &source);
    assert!(store::detach_domain(&mut connection, &repository, &source_domain).unwrap());
    let request = CopyMoveRequest::prepare(
        repository,
        CopyMoveInput {
            action: CopyMoveAction::Move,
            memory_id: source_id,
            from: source,
            to: PlacementId::Universal,
            operation_id: Some(operation_id("00000000-0000-0000-0000-000000000007")),
            applicability_note: None,
        },
    )
    .unwrap();

    // When
    let failure = store::copy_move(&mut connection, request);

    // Then
    assert!(failure
        .unwrap_err()
        .to_string()
        .contains("is not attached to this repository"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn copy_and_move_reject_foreign_repository_placements_without_mutation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let foreign_repository = other_repository();
    let source = PlacementId::Repository(repository.clone());
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let source_id = remember_source(&connection, &source);
    let foreign_destination = CopyMoveRequest::prepare(
        repository.clone(),
        CopyMoveInput {
            action: CopyMoveAction::Copy,
            memory_id: source_id,
            from: source.clone(),
            to: PlacementId::Repository(foreign_repository.clone()),
            operation_id: Some(operation_id("00000000-0000-0000-0000-000000000008")),
            applicability_note: None,
        },
    )
    .unwrap();
    let foreign_source = CopyMoveRequest::prepare(
        repository,
        CopyMoveInput {
            action: CopyMoveAction::Move,
            memory_id: source_id,
            from: PlacementId::Repository(foreign_repository),
            to: PlacementId::Universal,
            operation_id: Some(operation_id("00000000-0000-0000-0000-000000000009")),
            applicability_note: None,
        },
    )
    .unwrap();

    // When
    let destination_failure = store::copy_move(&mut connection, foreign_destination);
    let source_failure = store::copy_move(&mut connection, foreign_source);

    // Then
    for failure in [destination_failure, source_failure] {
        assert!(failure
            .unwrap_err()
            .to_string()
            .contains("repository placement must match the current repository"));
    }
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn replay_and_conflict_precede_detached_destination_validation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let destination_domain = domain("transfer/replay-after-detach");
    let destination = PlacementId::Domain(destination_domain.clone());
    let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
    let source_id = remember_source(&connection, &source);
    assert!(store::create_domain(&mut connection, &destination_domain).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &destination_domain, None).unwrap());
    let operation = operation_id("00000000-0000-0000-0000-000000000010");
    let copy = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source.clone(),
        to: destination.clone(),
        operation_id: Some(operation.clone()),
        applicability_note: None,
    };
    let copied = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository.clone(), copy.clone()).unwrap(),
    )
    .unwrap();
    assert!(store::detach_domain(&mut connection, &repository, &destination_domain).unwrap());
    let conflict = CopyMoveInput {
        action: CopyMoveAction::Move,
        memory_id: source_id,
        from: source,
        to: destination,
        operation_id: Some(operation),
        applicability_note: None,
    };

    // When
    let replayed = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository.clone(), copy).unwrap(),
    );
    let conflict = store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, conflict).unwrap(),
    );

    // Then
    assert_eq!(replayed.unwrap(), copied);
    assert!(conflict
        .unwrap_err()
        .to_string()
        .contains("operation ID conflict"));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

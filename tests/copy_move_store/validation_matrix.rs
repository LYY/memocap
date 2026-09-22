use memocap::{
    scope::{DomainId, OperationId, PlacementId, RepositoryId},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest},
};

use super::{domain, operation_id, other_repository, remember_source, repository};

#[derive(Clone, Copy)]
enum InvalidPlacement {
    DetachedSource,
    DetachedDestination,
    MissingSource,
    MissingDestination,
    ForeignSource,
    ForeignDestination,
}

struct Case {
    name: &'static str,
    action: CopyMoveAction,
    invalid_placement: InvalidPlacement,
    operation: &'static str,
    expected_error: &'static str,
}

struct RejectedTransfer<'a> {
    source_id: i64,
    source: &'a PlacementId,
    operation: &'a OperationId,
}

fn attached_domain(
    connection: &mut rusqlite::Connection,
    repository: &RepositoryId,
    value: &str,
) -> DomainId {
    let domain = domain(value);
    assert!(store::create_domain(connection, &domain).unwrap());
    assert!(store::attach_domain(connection, repository, &domain, None).unwrap());
    domain
}

fn detached_domain(
    connection: &mut rusqlite::Connection,
    repository: &RepositoryId,
    value: &str,
) -> DomainId {
    let domain = attached_domain(connection, repository, value);
    assert!(store::detach_domain(connection, repository, &domain).unwrap());
    domain
}

fn placement_fields(placement: &PlacementId) -> (String, Option<String>, Option<String>) {
    match placement {
        PlacementId::Repository(repository) => {
            ("repository".to_owned(), Some(repository.to_string()), None)
        }
        PlacementId::Domain(domain) => ("domain".to_owned(), None, Some(domain.to_string())),
        PlacementId::Universal => ("universal".to_owned(), None, None),
    }
}

fn assert_rejected_transfer_state(
    connection: &rusqlite::Connection,
    rejected: RejectedTransfer<'_>,
) {
    let surviving_placement = connection
        .query_row(
            "SELECT placement_kind, repository_id, domain_id FROM memories WHERE id = ?1",
            [rejected.source_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(surviving_placement, placement_fields(rejected.source));
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM memory_provenance WHERE operation_id = ?1",
                [rejected.operation.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM operation_ledger WHERE operation_id = ?1",
                [rejected.operation.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn copy_move_rejects_complete_placement_validation_matrix_without_mutation() {
    // Given
    let cases = [
        Case {
            name: "copy detached source",
            action: CopyMoveAction::Copy,
            invalid_placement: InvalidPlacement::DetachedSource,
            operation: "00000000-0000-0000-0000-000000000021",
            expected_error: "domain matrix/detached-source is not attached to this repository",
        },
        Case {
            name: "copy detached destination",
            action: CopyMoveAction::Copy,
            invalid_placement: InvalidPlacement::DetachedDestination,
            operation: "00000000-0000-0000-0000-000000000022",
            expected_error: "domain matrix/detached-destination is not attached to this repository",
        },
        Case {
            name: "move detached source",
            action: CopyMoveAction::Move,
            invalid_placement: InvalidPlacement::DetachedSource,
            operation: "00000000-0000-0000-0000-000000000023",
            expected_error: "domain matrix/detached-source is not attached to this repository",
        },
        Case {
            name: "move detached destination",
            action: CopyMoveAction::Move,
            invalid_placement: InvalidPlacement::DetachedDestination,
            operation: "00000000-0000-0000-0000-000000000024",
            expected_error: "domain matrix/detached-destination is not attached to this repository",
        },
        Case {
            name: "copy missing source",
            action: CopyMoveAction::Copy,
            invalid_placement: InvalidPlacement::MissingSource,
            operation: "00000000-0000-0000-0000-000000000025",
            expected_error: "domain matrix/missing-source does not exist",
        },
        Case {
            name: "move missing destination",
            action: CopyMoveAction::Move,
            invalid_placement: InvalidPlacement::MissingDestination,
            operation: "00000000-0000-0000-0000-000000000026",
            expected_error: "domain matrix/missing-destination does not exist",
        },
        Case {
            name: "copy foreign source",
            action: CopyMoveAction::Copy,
            invalid_placement: InvalidPlacement::ForeignSource,
            operation: "00000000-0000-0000-0000-000000000027",
            expected_error: "repository placement must match the current repository",
        },
        Case {
            name: "copy foreign destination",
            action: CopyMoveAction::Copy,
            invalid_placement: InvalidPlacement::ForeignDestination,
            operation: "00000000-0000-0000-0000-000000000028",
            expected_error: "repository placement must match the current repository",
        },
        Case {
            name: "move foreign source",
            action: CopyMoveAction::Move,
            invalid_placement: InvalidPlacement::ForeignSource,
            operation: "00000000-0000-0000-0000-000000000029",
            expected_error: "repository placement must match the current repository",
        },
        Case {
            name: "move foreign destination",
            action: CopyMoveAction::Move,
            invalid_placement: InvalidPlacement::ForeignDestination,
            operation: "00000000-0000-0000-0000-000000000030",
            expected_error: "repository placement must match the current repository",
        },
    ];

    for case in cases {
        let directory = tempfile::tempdir().unwrap();
        let repository = repository();
        let mut connection = store::open(&directory.path().join("memocap.db")).unwrap();
        let (surviving_source, source_id) = match case.invalid_placement {
            InvalidPlacement::DetachedSource => {
                let source_domain =
                    attached_domain(&mut connection, &repository, "matrix/detached-source");
                let source = PlacementId::Domain(source_domain.clone());
                let source_id = remember_source(&connection, &source);
                assert!(
                    store::detach_domain(&mut connection, &repository, &source_domain).unwrap()
                );
                (source, source_id)
            }
            _ => {
                let source = PlacementId::Repository(repository.clone());
                let source_id = remember_source(&connection, &source);
                (source, source_id)
            }
        };
        let requested_source = match case.invalid_placement {
            InvalidPlacement::MissingSource => PlacementId::Domain(domain("matrix/missing-source")),
            InvalidPlacement::ForeignSource => PlacementId::Repository(other_repository()),
            _ => surviving_source.clone(),
        };
        let requested_destination = match case.invalid_placement {
            InvalidPlacement::DetachedDestination => PlacementId::Domain(detached_domain(
                &mut connection,
                &repository,
                "matrix/detached-destination",
            )),
            InvalidPlacement::MissingDestination => {
                PlacementId::Domain(domain("matrix/missing-destination"))
            }
            InvalidPlacement::ForeignDestination => PlacementId::Repository(other_repository()),
            _ => PlacementId::Universal,
        };
        let operation = operation_id(case.operation);
        let request = CopyMoveRequest::prepare(
            repository.clone(),
            CopyMoveInput {
                action: case.action,
                memory_id: source_id,
                from: requested_source,
                to: requested_destination,
                operation_id: Some(operation.clone()),
                applicability_note: None,
            },
        )
        .unwrap();

        // When
        let failure = store::copy_move(&mut connection, request).unwrap_err();

        // Then
        assert_eq!(failure.to_string(), case.expected_error, "{}", case.name);
        assert_rejected_transfer_state(
            &connection,
            RejectedTransfer {
                source_id,
                source: &surviving_source,
                operation: &operation,
            },
        );
    }
}

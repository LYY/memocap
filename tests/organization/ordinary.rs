use super::support::*;
use memocap::{
    scope::{PlacementId, RepositoryId},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest, RememberOptions},
};

#[test]
fn copy_starts_pending_while_move_preserves_organization_state() {
    for action in [CopyMoveAction::Copy, CopyMoveAction::Move] {
        let (_directory, _path, mut connection) = database();
        let repository: RepositoryId = format!("repository:{}", "a".repeat(64)).parse().unwrap();
        let from = PlacementId::Repository(repository.clone());
        let source = store::remember_at(
            &connection,
            &from,
            "source",
            "context",
            "",
            RememberOptions {
                topic_key: None,
                force: true,
                overwrite_id: None,
            },
        )
        .unwrap();
        connection
            .execute(
                "UPDATE memories SET organized_at='organized' WHERE id=?1",
                [source],
            )
            .unwrap();
        let request = CopyMoveRequest::prepare(
            repository,
            CopyMoveInput {
                action,
                memory_id: source,
                from,
                to: PlacementId::Universal,
                operation_id: None,
                applicability_note: None,
            },
        )
        .unwrap();

        let transferred = store::copy_move(&mut connection, request).unwrap();

        let status: Option<String> = connection
            .query_row(
                "SELECT organized_at FROM memories WHERE id=?1",
                [transferred.memory_id],
                |row| row.get(0),
            )
            .unwrap();
        match action {
            CopyMoveAction::Copy => assert_eq!(status, None),
            CopyMoveAction::Move => assert_eq!(status.as_deref(), Some("organized")),
        }
    }
}

#[test]
fn ordinary_content_edit_preserves_organization_state() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "original");
    connection
        .execute(
            "UPDATE memories SET organized_at='organized' WHERE id=?1",
            [id],
        )
        .unwrap();

    store::remember_at(
        &connection,
        &PlacementId::Universal,
        "edited",
        "decision",
        "tag",
        RememberOptions {
            topic_key: None,
            force: false,
            overwrite_id: Some(id),
        },
    )
    .unwrap();

    let edited = snapshot(&path, id);
    assert_eq!(edited["content"], "edited");
    assert_eq!(edited["organized_at"], "organized");
}

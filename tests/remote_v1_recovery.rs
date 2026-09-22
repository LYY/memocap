use std::{path::PathBuf, sync::mpsc, thread};

use memocap::{
    remote,
    scope::{OperationId, PlacementId, RepositoryId},
    server::{self, Incoming},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest, RememberOptions},
};
use tiny_http::{Header, Response, Server, StatusCode};

#[path = "remote_v1_recovery/transfer_race.rs"]
mod transfer_race;

const TOKEN: &str = "remote-recovery-token";

fn repository() -> RepositoryId {
    "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        .parse()
        .unwrap()
}

fn response_loss_server(
    database: PathBuf,
) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        for (index, mut request) in server.incoming_requests().take(3).enumerate() {
            let token = request
                .headers()
                .iter()
                .find(|header| {
                    header
                        .field
                        .as_str()
                        .as_str()
                        .eq_ignore_ascii_case("authorization")
                })
                .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
                .map(ToOwned::to_owned);
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let incoming = Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token,
                body,
            };
            let path = incoming.path.clone();
            let outgoing = server::handle(&database, TOKEN, &incoming);
            sender.send(path).unwrap();
            if index == 0 {
                continue;
            }
            request
                .respond(
                    Response::from_string(outgoing.body)
                        .with_status_code(StatusCode(outgoing.status))
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .unwrap(),
                        ),
                )
                .unwrap();
        }
    });
    (address, receiver, handle)
}

#[test]
fn response_loss_recovers_committed_copy_once_from_a_strict_handle() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let repository = repository();
    let source = PlacementId::Repository(repository.clone());
    let source_id = {
        let connection = store::open(&database).unwrap();
        store::remember_at(
            &connection,
            &source,
            "response loss source",
            "note",
            "",
            RememberOptions {
                topic_key: None,
                force: false,
                overwrite_id: None,
            },
        )
        .unwrap()
    };
    let request = CopyMoveRequest::prepare(
        repository.clone(),
        CopyMoveInput {
            action: CopyMoveAction::Copy,
            memory_id: source_id,
            from: source,
            to: PlacementId::Universal,
            operation_id: Some(
                "00000000-0000-0000-0000-000000000701"
                    .parse::<OperationId>()
                    .unwrap(),
            ),
            applicability_note: Some("recoverable copy".to_owned()),
        },
    )
    .unwrap();
    let handle = remote::RecoveryHandle::from_request(&request).unwrap();
    let (address, receiver, server) = response_loss_server(database.clone());

    // When
    let copied = remote::copy_move(&address, TOKEN, &request).unwrap();
    let reloaded = handle
        .to_string()
        .parse::<remote::RecoveryHandle>()
        .unwrap();
    let recovered = remote::operation_status(&address, TOKEN, &reloaded).unwrap();

    // Then
    assert_eq!(copied.action, CopyMoveAction::Copy);
    assert_ne!(copied.memory_id, source_id);
    assert!(matches!(
        recovered,
        remote::OperationStatus::Committed(ref result) if result == &copied
    ));
    server.join().unwrap();
    assert_eq!(
        receiver.iter().collect::<Vec<_>>(),
        vec![
            "/v1/memories/copy",
            "/v1/operations/status",
            "/v1/operations/status",
        ]
    );
    let connection = store::open(&database).unwrap();
    assert_eq!(
        store::list_inventory(
            &connection,
            &store::visible_sources(&connection, &repository).unwrap(),
            20
        )
        .unwrap()
        .len(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn recovery_handle_rejects_malformed_identity() {
    assert!(
        "operation-recovery:v1:bad:00000000-0000-0000-0000-000000000701:abc"
            .parse::<remote::RecoveryHandle>()
            .is_err()
    );
}

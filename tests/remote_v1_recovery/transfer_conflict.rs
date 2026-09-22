use std::{path::PathBuf, thread};

use memocap::{
    remote,
    scope::{OperationId, PlacementId},
    server::{self, Incoming},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest, RememberOptions},
};
use tiny_http::{Header, Response, Server, StatusCode};

use super::{repository, TOKEN};

fn conflict_server(database: PathBuf) -> (String, thread::JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let handle = thread::spawn(move || {
        let mut request = server.incoming_requests().next().unwrap();
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
        let outgoing = server::handle(
            &database,
            TOKEN,
            &Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token,
                body,
            },
        );
        request
            .respond(
                Response::from_string(outgoing.body)
                    .with_status_code(StatusCode(outgoing.status))
                    .with_header(
                        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
                    ),
            )
            .unwrap();
    });
    (address, handle)
}

#[test]
fn remote_copy_move_conflict_returns_exact_wire_error() {
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
            "conflict source",
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
    let operation_id = "00000000-0000-0000-0000-000000000711"
        .parse::<OperationId>()
        .unwrap();
    let committed = CopyMoveInput {
        action: CopyMoveAction::Copy,
        memory_id: source_id,
        from: source.clone(),
        to: PlacementId::Universal,
        operation_id: Some(operation_id.clone()),
        applicability_note: None,
    };
    let conflict = CopyMoveRequest::prepare(
        repository.clone(),
        CopyMoveInput {
            action: CopyMoveAction::Move,
            memory_id: source_id,
            from: source,
            to: PlacementId::Universal,
            operation_id: Some(operation_id),
            applicability_note: None,
        },
    )
    .unwrap();
    let mut connection = store::open(&database).unwrap();
    store::copy_move(
        &mut connection,
        CopyMoveRequest::prepare(repository, committed).unwrap(),
    )
    .unwrap();
    let (address, server) = conflict_server(database);

    // When
    let failure = remote::copy_move(&address, TOKEN, &conflict).unwrap_err();

    // Then
    assert_eq!(
        failure.to_string(),
        "remote request failed (409): {\"error\":\"conflict\"}"
    );
    server.join().unwrap();
}

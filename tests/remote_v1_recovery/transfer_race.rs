use std::{path::PathBuf, sync::mpsc, thread};

use memocap::{
    remote,
    scope::{DomainId, PlacementId},
    server::{self, Incoming},
    store::{self, CopyMoveAction, CopyMoveInput, CopyMoveRequest, RememberOptions},
};
use tiny_http::{Header, Response, Server, StatusCode};

use super::{repository, TOKEN};

fn coordinated_transfer_server(
    database: PathBuf,
) -> (
    String,
    mpsc::Receiver<()>,
    mpsc::SyncSender<()>,
    thread::JoinHandle<()>,
) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let (release_sender, release_receiver) = mpsc::sync_channel(1);
    let handle = thread::spawn(move || {
        let mut transfer_request = server.incoming_requests().next().unwrap();
        let mut transfer_body = String::new();
        transfer_request
            .as_reader()
            .read_to_string(&mut transfer_body)
            .unwrap();
        let transfer_incoming = Incoming {
            method: transfer_request.method().to_string().to_ascii_uppercase(),
            path: transfer_request.url().to_owned(),
            token: transfer_request
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
                .map(ToOwned::to_owned),
            body: transfer_body,
        };
        let transfer_database = database.clone();
        let transfer = thread::spawn(move || {
            ready_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
            let outgoing = server::handle(&transfer_database, TOKEN, &transfer_incoming);
            transfer_request
                .respond(
                    Response::from_string(outgoing.body)
                        .with_status_code(StatusCode(outgoing.status))
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .unwrap(),
                        ),
                )
                .unwrap();
        });
        let mut detach_request = server.incoming_requests().next().unwrap();
        let mut detach_body = String::new();
        detach_request
            .as_reader()
            .read_to_string(&mut detach_body)
            .unwrap();
        let detach_incoming = Incoming {
            method: detach_request.method().to_string().to_ascii_uppercase(),
            path: detach_request.url().to_owned(),
            token: detach_request
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
                .map(ToOwned::to_owned),
            body: detach_body,
        };
        let outgoing = server::handle(&database, TOKEN, &detach_incoming);
        detach_request
            .respond(
                Response::from_string(outgoing.body)
                    .with_status_code(StatusCode(outgoing.status))
                    .with_header(
                        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
                    ),
            )
            .unwrap();
        transfer.join().unwrap();
    });
    (address, ready_receiver, release_sender, handle)
}

#[test]
fn remote_copy_rejects_destination_detached_before_store_without_mutation() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let repository = repository();
    let domain = "transfer/remote-handoff".parse::<DomainId>().unwrap();
    let source = PlacementId::Repository(repository.clone());
    let source_id = {
        let mut connection = store::open(&database).unwrap();
        let source_id = store::remember_at(
            &connection,
            &source,
            "remote handoff source",
            "note",
            "",
            RememberOptions {
                topic_key: None,
                force: false,
                overwrite_id: None,
            },
        )
        .unwrap();
        assert!(store::create_domain(&mut connection, &domain).unwrap());
        assert!(store::attach_domain(&mut connection, &repository, &domain, None).unwrap());
        source_id
    };
    let request = CopyMoveRequest::prepare(
        repository.clone(),
        CopyMoveInput {
            action: CopyMoveAction::Copy,
            memory_id: source_id,
            from: source,
            to: PlacementId::Domain(domain.clone()),
            operation_id: Some("00000000-0000-0000-0000-000000000702".parse().unwrap()),
            applicability_note: None,
        },
    )
    .unwrap();
    let (address, ready_receiver, release_sender, server) =
        coordinated_transfer_server(database.clone());
    let transfer_address = address.clone();
    let transfer = thread::spawn(move || remote::copy_move(&transfer_address, TOKEN, &request));
    ready_receiver.recv().unwrap();

    // When
    assert!(remote::detach_domain(&address, TOKEN, &repository, &domain).unwrap());
    release_sender.send(()).unwrap();
    let failure = transfer.join().unwrap().unwrap_err();

    // Then
    assert_eq!(
        failure.to_string(),
        "remote request failed (400): {\"error\":\"invalid_request\"}"
    );
    server.join().unwrap();
    let connection = store::open(&database).unwrap();
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

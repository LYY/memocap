use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
};

use memocap::{
    remote,
    scope::{DomainId, PlacementId, RepositoryId},
    server::{self, Incoming},
};
use tiny_http::{Header, Response, Server, StatusCode};

const TOKEN: &str = "remote-v1-token";

fn repository() -> RepositoryId {
    "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        .parse()
        .unwrap()
}

fn test_server(
    database: PathBuf,
    requests: usize,
) -> (String, Receiver<(String, String)>, JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        for mut request in server.incoming_requests().take(requests) {
            let authorization = request
                .headers()
                .iter()
                .find(|header| {
                    header
                        .field
                        .as_str()
                        .as_str()
                        .eq_ignore_ascii_case("authorization")
                })
                .map(|header| header.value.as_str().to_owned())
                .unwrap_or_default();
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let incoming = Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token: authorization.strip_prefix("Bearer ").map(ToOwned::to_owned),
                body,
            };
            let outgoing = server::handle(&database, TOKEN, &incoming);
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
            sender.send((incoming.path, authorization)).unwrap();
        }
    });
    (address, receiver, handle)
}

#[test]
fn remote_client_uses_authenticated_v1_for_memory_domains_and_status() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let repository = repository();
    let placement = PlacementId::Repository(repository.clone());
    let domain: DomainId = "engineering/rust".parse().unwrap();
    let (address, receiver, handle) = test_server(database, 8);

    // When
    let memory_id = remote::remember(
        &address,
        TOKEN,
        remote::RememberRequest {
            repository: &repository,
            placement: &placement,
            content: "remote client memory",
            kind: "note",
            tags: "",
            topic_key: None,
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    assert!(remote::create_domain(&address, TOKEN, &repository, &domain).unwrap());
    assert!(remote::attach_domain(&address, TOKEN, &repository, &domain, None).unwrap());
    let recalled = remote::recall(
        &address,
        TOKEN,
        remote::RecallRequest {
            repository: &repository,
            placement: None,
            query: "remote",
            limit: 20,
            kind: None,
            max_chars: None,
        },
    )
    .unwrap();
    let listed = remote::list(&address, TOKEN, &repository, None, 20).unwrap();
    let status = remote::status(&address, TOKEN, &repository).unwrap();
    assert!(remote::forget(&address, TOKEN, &repository, &placement, memory_id).unwrap());
    assert!(remote::detach_domain(&address, TOKEN, &repository, &domain).unwrap());

    // Then
    assert_eq!(recalled.len(), 1);
    assert_eq!(listed.len(), 1);
    assert_eq!(status.domains, vec![domain]);
    handle.join().unwrap();
    let requests = receiver.iter().collect::<Vec<_>>();
    assert_eq!(requests.len(), 8);
    assert!(requests
        .iter()
        .all(|(_, authorization)| authorization == "Bearer remote-v1-token"));
    assert_eq!(
        requests
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/v1/memories/remember",
            "/v1/domains/create",
            "/v1/domains/attach",
            "/v1/memories/recall",
            "/v1/memories/list",
            "/v1/status",
            "/v1/memories/forget",
            "/v1/domains/detach",
        ]
    );
}

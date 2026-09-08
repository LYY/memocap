use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
};

use memocap::{
    config::{resolve_target_from, token_matches},
    remote,
    scope::ScopeId,
    server::{self, Incoming},
    store,
};
use tiny_http::{Header, Response, Server, StatusCode};

const TOKEN: &str = "remote-test-token";
const REPOSITORY_SCOPE: &str =
    "scope:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn test_server(
    database: PathBuf,
    request_count: usize,
) -> (String, Receiver<Incoming>, JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let connection = store::open(&database).unwrap();
        for mut request in server.incoming_requests().take(request_count) {
            let url = request.url().to_owned();
            let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
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
                .map(|header| {
                    header
                        .value
                        .as_str()
                        .strip_prefix("Bearer ")
                        .unwrap_or(header.value.as_str())
                        .trim()
                        .to_owned()
                });
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let incoming = Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: path.to_owned(),
                query: query.to_owned(),
                token,
                body,
            };
            let outgoing = server::handle(&connection, TOKEN, &incoming);
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
            sender.send(incoming).unwrap();
        }
    });
    (address, receiver, handle)
}

fn scoped_path(path: &str, scope: &str) -> String {
    format!("{path}?scope={scope}")
}

fn invalid_scopes() -> [&'static str; 4] {
    [
        "",
        "scope:v1:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "scope:v1:abc",
        "/tmp/raw-path",
    ]
}

#[test]
fn remote_memory_requests_require_scopes_and_match_local_results() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let global = ScopeId::global();
    let repository = REPOSITORY_SCOPE.parse::<ScopeId>().unwrap();
    let (address, receiver, handle) = test_server(database.clone(), 10);

    remote::remember(
        &address,
        TOKEN,
        remote::RememberRequest {
            scope: &global,
            content: "global baseline",
            kind: "note",
            tags: "",
            topic_key: None,
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    remote::remember(
        &address,
        TOKEN,
        remote::RememberRequest {
            scope: &global,
            content: "global delivery",
            kind: "note",
            tags: "",
            topic_key: Some("status"),
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    remote::remember(
        &address,
        TOKEN,
        remote::RememberRequest {
            scope: &repository,
            content: "repository delivery",
            kind: "note",
            tags: "",
            topic_key: Some("status"),
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    let empty_topic = remote::remember(
        &address,
        TOKEN,
        remote::RememberRequest {
            scope: &repository,
            content: "repository empty topic",
            kind: "note",
            tags: "",
            topic_key: Some(""),
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    let recalled = remote::recall(
        &address,
        TOKEN,
        remote::RecallRequest {
            scope: &repository,
            query: "delivery",
            limit: 20,
            kind: None,
            max_chars: None,
        },
    )
    .unwrap();
    let listed_before_forget = remote::list(&address, TOKEN, &repository, 20).unwrap();
    assert_eq!(listed_before_forget.len(), 4);
    assert_eq!(remote::count(&address, TOKEN, &repository).unwrap(), 4);
    assert!(remote::forget(&address, TOKEN, &repository, empty_topic).unwrap());
    let listed = remote::list(&address, TOKEN, &repository, 20).unwrap();
    assert_eq!(remote::count(&address, TOKEN, &repository).unwrap(), 3);

    handle.join().unwrap();
    let requests = receiver.iter().collect::<Vec<_>>();
    assert_eq!(requests.len(), 10);

    let first_body: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(first_body["scope"], "global");
    assert!(first_body.get("topic_key").is_none());
    let second_body: serde_json::Value = serde_json::from_str(&requests[1].body).unwrap();
    assert_eq!(second_body["topic_key"], "status");
    let third_body: serde_json::Value = serde_json::from_str(&requests[2].body).unwrap();
    assert_eq!(third_body["scope"], REPOSITORY_SCOPE);
    let fourth_body: serde_json::Value = serde_json::from_str(&requests[3].body).unwrap();
    assert_eq!(fourth_body["topic_key"], "");
    for request in [
        &requests[4],
        &requests[5],
        &requests[6],
        &requests[8],
        &requests[9],
    ] {
        assert_eq!(request.query.matches("scope=").count(), 1);
        assert!(request.query.contains("scope=scope%3Av1%3A"));
    }
    let forget_body: serde_json::Value = serde_json::from_str(&requests[7].body).unwrap();
    assert_eq!(forget_body["scope"], REPOSITORY_SCOPE);

    let connection = store::open(&database).unwrap();
    assert_eq!(
        recalled,
        store::recall_scoped(&connection, &repository, "delivery", 20, None, None).unwrap()
    );
    assert_eq!(
        listed,
        store::list_scoped(&connection, &repository, 20).unwrap()
    );
    assert_eq!(store::count_scoped(&connection, &repository).unwrap(), 3);
}

#[test]
fn server_rejects_missing_or_invalid_scopes_before_store_access() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let remember = r#"{"content":"write must not happen","type":"note","tags":""}"#;
    let forget = r#"{"id":1}"#;

    assert_eq!(
        server::dispatch("POST", "/remember", true, remember, &database).0,
        400
    );
    assert_eq!(
        server::dispatch("POST", "/forget", true, forget, &database).0,
        400
    );
    for path in ["/recall?q=write", "/list", "/count"] {
        assert_eq!(server::dispatch("GET", path, true, "", &database).0, 400);
    }

    for scope in invalid_scopes() {
        let remember = serde_json::json!({
            "content": "write must not happen",
            "type": "note",
            "tags": "",
            "scope": scope,
        })
        .to_string();
        let forget = serde_json::json!({"id": 1, "scope": scope}).to_string();
        assert_eq!(
            server::dispatch("POST", "/remember", true, &remember, &database).0,
            400
        );
        assert_eq!(
            server::dispatch("POST", "/forget", true, &forget, &database).0,
            400
        );
        for path in ["/recall?q=write", "/list", "/count"] {
            assert_eq!(
                server::dispatch("GET", &scoped_path(path, scope), true, "", &database).0,
                400
            );
        }
    }

    let connection = store::open(&database).unwrap();
    assert_eq!(store::count(&connection).unwrap(), 0);
    let unauthorized = server::dispatch(
        "GET",
        &scoped_path("/count", REPOSITORY_SCOPE),
        false,
        "",
        &database,
    );
    assert_eq!(unauthorized.0, 401);
    assert_eq!(unauthorized.1, r#"{"error":"unauthorized"}"#);
}

#[test]
fn no_address_stays_local() {
    let target = resolve_target_from(None, Some("tok"), PathBuf::from("/tmp/x.db")).unwrap();
    assert!(matches!(target, memocap::config::Target::Local { .. }));
}

#[test]
fn token_reject() {
    assert!(!token_matches("secret", "wrong"));
    assert!(!token_matches("secret", ""));
    assert!(token_matches("secret", "secret"));
}

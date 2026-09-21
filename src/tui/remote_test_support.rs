use std::{
    path::PathBuf,
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tiny_http::{Header, Response, Server, StatusCode};

pub(super) const REMOTE_TOKEN: &str = "tui-remote-token";

pub(super) struct RemoteRequest {
    pub(super) path: String,
    pub(super) body: String,
}

pub(super) fn remote_server(
    database: PathBuf,
    expected_requests: usize,
) -> (String, Receiver<RemoteRequest>, JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").expect("remote server should bind");
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut received = 0;
        while Instant::now() < deadline {
            let Some(mut request) = server
                .recv_timeout(Duration::from_millis(50))
                .expect("remote request should receive")
            else {
                continue;
            };
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
            std::io::Read::read_to_string(&mut request.as_reader(), &mut body)
                .expect("remote request body should read");
            let incoming = crate::server::Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token,
                body,
            };
            let outgoing = crate::server::handle(&database, REMOTE_TOKEN, &incoming);
            request
                .respond(
                    Response::from_string(outgoing.body)
                        .with_status_code(StatusCode(outgoing.status))
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .expect("content type should parse"),
                        ),
                )
                .expect("remote response should send");
            sender
                .send(RemoteRequest {
                    path: incoming.path,
                    body: incoming.body,
                })
                .expect("remote request should send");
            received += 1;
            if received == expected_requests {
                return;
            }
        }
    });
    (address, receiver, handle)
}

pub(super) fn partial_remote_server() -> (String, Receiver<RemoteRequest>, JoinHandle<()>) {
    let server = Server::http("127.0.0.1:0").expect("remote server should bind");
    let address = format!("http://{}", server.server_addr());
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut index = 0;
        while index < 2 && Instant::now() < deadline {
            let Some(mut request) = server
                .recv_timeout(Duration::from_millis(50))
                .expect("partial remote request should receive")
            else {
                continue;
            };
            let mut body = String::new();
            std::io::Read::read_to_string(&mut request.as_reader(), &mut body)
                .expect("remote request body should read");
            let path = request.url().to_owned();
            let reply = match index {
                0 => serde_json::json!({
                    "domains": [],
                    "status": {
                        "schema_version": "1.0",
                        "placements": [],
                        "addressable_total": 1,
                        "effective_total": 1
                    }
                }),
                1 => serde_json::json!({"memories": []}),
                _ => unreachable!("server accepts exactly two requests"),
            };
            request
                .respond(
                    Response::from_string(reply.to_string())
                        .with_status_code(StatusCode(200))
                        .with_header(
                            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                                .expect("content type should parse"),
                        ),
                )
                .expect("remote response should send");
            sender
                .send(RemoteRequest { path, body })
                .expect("remote request should send");
            index += 1;
        }
    });
    (address, receiver, handle)
}

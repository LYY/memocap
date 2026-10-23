use std::{path::PathBuf, thread, time::Duration};
use tiny_http::{Response, Server, StatusCode};

pub enum Mode {
    Normal,
    Old,
    MalformedWrite,
}

pub fn start(
    database: PathBuf,
    mode: Mode,
    count: usize,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let handle = thread::spawn(move || {
        let mut paths = Vec::new();
        for _ in 0..count {
            let mut request = server
                .recv_timeout(Duration::from_secs(4))
                .unwrap()
                .unwrap();
            let path = request.url().to_owned();
            let token = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
                .map(str::to_owned);
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let outgoing = memocap::server::handle(
                &database,
                "receipt-test-token",
                &memocap::server::Incoming {
                    method: request.method().to_string(),
                    path: path.clone(),
                    token,
                    body,
                },
            );
            let (status, body) = match mode {
                Mode::Old => (404, "{}".to_owned()),
                Mode::MalformedWrite if path == "/v1/receipt" => (200, "{}".to_owned()),
                Mode::Normal | Mode::MalformedWrite => (outgoing.status, outgoing.body),
            };
            request
                .respond(Response::from_string(body).with_status_code(StatusCode(status)))
                .unwrap();
            paths.push(path);
        }
        paths
    });
    (address, handle)
}

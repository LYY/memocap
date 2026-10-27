use serde::{Deserialize, Serialize};
use std::{
    io,
    path::PathBuf,
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};
use tiny_http::{Response, Server, StatusCode};

pub enum Mode {
    Normal,
    Old,
    MalformedWrite,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReceiptMetadata {
    format_version: Option<u32>,
    backend: Option<String>,
    origin: Option<String>,
    operation: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum Stage {
    Received,
    BodyRead,
    DispatchStarted,
    Dispatched,
    Responding { http: u16, receipt: ReceiptMetadata },
    Responded { error: Option<String> },
    IdleExpired,
}

#[derive(Debug, Serialize)]
pub struct Event {
    elapsed_us: u128,
    path: Option<String>,
    stage: Stage,
}

struct Observer {
    sender: Sender<Event>,
    started: Instant,
}

impl Observer {
    fn record(&self, path: Option<&str>, stage: Stage) {
        self.sender
            .send(Event {
                elapsed_us: self.started.elapsed().as_micros(),
                path: path.map(str::to_owned),
                stage,
            })
            .unwrap();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Termination {
    Completed,
    IdleExpired,
    IoError(String),
    Panicked(String),
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub events: Vec<Event>,
    pub termination: Termination,
    joined_elapsed_us: u128,
}

impl Report {
    pub fn paths(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter_map(|event| match event.stage {
                Stage::Received => event.path.as_deref(),
                Stage::BodyRead
                | Stage::DispatchStarted
                | Stage::Dispatched
                | Stage::Responding { .. }
                | Stage::Responded { .. }
                | Stage::IdleExpired => None,
            })
            .collect()
    }
}

pub struct Fixture {
    handle: Option<thread::JoinHandle<io::Result<Termination>>>,
    receiver: Receiver<Event>,
    started: Instant,
}

impl Fixture {
    pub fn join(mut self) -> Report {
        self.finish()
    }

    fn finish(&mut self) -> Report {
        let termination = match self.handle.take().unwrap().join() {
            Ok(Ok(termination)) => termination,
            Ok(Err(error)) => Termination::IoError(error.to_string()),
            Err(panic) => Termination::Panicked(match panic.downcast::<String>() {
                Ok(message) => *message,
                Err(panic) => match panic.downcast::<&str>() {
                    Ok(message) => (*message).to_owned(),
                    Err(_) => "non-string panic payload".to_owned(),
                },
            }),
        };
        Report {
            events: self.receiver.try_iter().collect(),
            termination,
            joined_elapsed_us: self.started.elapsed().as_micros(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.handle.is_some() {
            eprintln!("{}", serde_json::to_string(&self.finish()).unwrap());
        }
    }
}

pub fn start(database: PathBuf, mode: Mode, count: usize) -> (String, Fixture) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let started = Instant::now();
    let (sender, receiver) = mpsc::channel();
    let observer = Observer { sender, started };
    let handle = thread::spawn(move || -> io::Result<Termination> {
        for _ in 0..count {
            let Some(mut request) = server.recv_timeout(Duration::from_secs(4))? else {
                observer.record(None, Stage::IdleExpired);
                return Ok(Termination::IdleExpired);
            };
            let path = request.url().to_owned();
            observer.record(Some(&path), Stage::Received);
            let token = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
                .map(str::to_owned);
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body)?;
            observer.record(Some(&path), Stage::BodyRead);
            observer.record(Some(&path), Stage::DispatchStarted);
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
            observer.record(Some(&path), Stage::Dispatched);
            let (status, body) = match mode {
                Mode::Old => (404, "{}".to_owned()),
                Mode::MalformedWrite if path == "/v1/receipt" => (200, "{}".to_owned()),
                Mode::Normal | Mode::MalformedWrite => (outgoing.status, outgoing.body),
            };
            let receipt = serde_json::from_str(&body).map_err(io::Error::other)?;
            observer.record(
                Some(&path),
                Stage::Responding {
                    http: status,
                    receipt,
                },
            );
            let response =
                request.respond(Response::from_string(body).with_status_code(StatusCode(status)));
            observer.record(
                Some(&path),
                Stage::Responded {
                    error: response.as_ref().err().map(ToString::to_string),
                },
            );
            response?;
        }
        Ok(Termination::Completed)
    });
    (
        address,
        Fixture {
            handle: Some(handle),
            receiver,
            started,
        },
    )
}

#[test]
fn body_read_error_retains_received_path_after_join() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.db");
    let (address, handle) = start(db.clone(), Mode::Normal, 1);
    let mut stream =
        std::net::TcpStream::connect(address.strip_prefix("http://").unwrap()).unwrap();
    stream.write_all(b"POST /v1/receipt HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\ninvalid-chunk\r\n").unwrap();
    drop(stream);
    let observed = handle.join();
    eprintln!("{}", serde_json::to_string(&observed).unwrap());
    assert_eq!(observed.paths(), ["/v1/receipt"]);
    assert!(matches!(observed.termination, Termination::IoError(_)));
    assert_eq!(observed.events.len(), 1);
    assert!(!db.exists());
}

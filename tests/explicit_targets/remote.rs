use std::{thread, time::Duration};

use memocap::server::{self, Incoming};
use tiny_http::{Response, Server, StatusCode};

use super::{text, Fixture};

#[test]
fn explicit_remote_targets_select_real_server_repository_namespaces() {
    let fixture = Fixture::new();
    let database = fixture.root.path().join("server.db");
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let worker = thread::spawn(move || {
        for _ in 0..9 {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let token = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
                .map(str::to_owned);
            let outgoing = server::handle(
                &database,
                "target-test-token",
                &Incoming {
                    method: request.method().to_string(),
                    path: request.url().to_owned(),
                    token,
                    body,
                },
            );
            request
                .respond(
                    Response::from_string(outgoing.body)
                        .with_status_code(StatusCode(outgoing.status)),
                )
                .unwrap();
        }
    });
    let run = |arguments: &[&str]| {
        text(
            fixture
                .command()
                .env("MEMOCAP_ADDR", &address)
                .env("MEMOCAP_TOKEN", "target-test-token")
                .args(arguments)
                .output()
                .unwrap(),
        )
    };
    let a = fixture.a.to_str().unwrap();
    let b = fixture.b.to_str().unwrap();
    run(&["remember", "remote alpha", "--repo", a]);
    run(&["remember", "remote beta", "--repo", b]);

    let only_a = run(&["recall", "remote", "--repo", a]);
    let merged = run(&["recall", "remote", "--repo", a, "--repo", b]);
    let list_b = run(&["list", "--repo", b]);
    let status = run(&["status", "--repo", b]);
    let shown = run(&["scope", "show", "--repo", b]);
    run(&["forget", "1", "--repo", a]);

    assert!(only_a.contains("remote alpha"));
    assert!(!only_a.contains("remote beta"));
    assert!(!list_b.contains("remote alpha"));
    assert!(list_b.contains("remote beta"));
    assert!(merged.contains("remote alpha"));
    assert!(merged.contains("remote beta"));
    let repository = memocap::scope::resolve_readonly(&fixture.b).unwrap();
    assert!(status.contains(repository.repository().as_str()));
    assert!(shown.contains(repository.repository().as_str()));
    worker.join().unwrap();
    assert!(!fixture.database.exists());
}

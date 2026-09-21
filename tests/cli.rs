use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use memocap::{
    scope::PlacementId,
    server::{self, Incoming},
    store::{self, RememberOptions},
};
use tiny_http::{Header, Response, Server, StatusCode};

struct CliFixture {
    _temp: tempfile::TempDir,
    data_dir: PathBuf,
    home: PathBuf,
    repo_a: PathBuf,
    repo_b: PathBuf,
}

impl CliFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let home = temp.path().join("home");
        let repo_a = temp.path().join("repo-a");
        let repo_b = temp.path().join("repo-b");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&home).unwrap();
        init_repo(&repo_a);
        init_repo(&repo_b);
        Self {
            _temp: temp,
            data_dir,
            home,
            repo_a,
            repo_b,
        }
    }

    fn run(&self, cwd: &Path, arguments: &[&str]) -> Output {
        let mut command = self.command(cwd, &self.data_dir, arguments);
        command.output().unwrap()
    }

    fn command(&self, cwd: &Path, data_dir: &Path, arguments: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
        command
            .args(arguments)
            .current_dir(cwd)
            .env("MEMOCAP_DATA_DIR", data_dir)
            .env("MEMOCAP_HOME", &self.home)
            .env_remove("MEMOCAP_ADDR")
            .env_remove("MEMOCAP_URL")
            .env_remove("MEMOCAP_ADDRESS")
            .env_remove("MEMOCAP_TOKEN");
        command
    }
}

fn init_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(path)
        .env("GIT_MASTER", "1")
        .status()
        .unwrap();
    assert!(status.success());
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_failure(output: &Output, expected: &str) {
    assert!(
        !output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(expected),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn saved_id(output: &Output) -> i64 {
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .strip_prefix("saved #")
        .unwrap()
        .parse()
        .unwrap()
}

fn remote_server(
    database: PathBuf,
    expected_token: &'static str,
    requests: usize,
) -> (String, JoinHandle<Vec<String>>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.server_addr());
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut paths = Vec::new();
        while paths.len() < requests && Instant::now() < deadline {
            let Some(mut request) = server.recv_timeout(Duration::from_millis(50)).unwrap() else {
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
            request.as_reader().read_to_string(&mut body).unwrap();
            let incoming = Incoming {
                method: request.method().to_string().to_ascii_uppercase(),
                path: request.url().to_owned(),
                token,
                body,
            };
            let outgoing = server::handle(&database, expected_token, &incoming);
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
            paths.push(incoming.path);
        }
        paths
    });
    (address, handle)
}

#[test]
fn default_memory_commands_isolate_repositories_and_reject_cross_scope_forget() {
    let fixture = CliFixture::new();

    let a = fixture.run(&fixture.repo_a, &["remember", "alpha isolation"]);
    assert_success(&a);
    let a_id = saved_id(&a);
    let b = fixture.run(&fixture.repo_b, &["remember", "bravo isolation"]);
    assert_success(&b);

    let a_recall = fixture.run(&fixture.repo_a, &["recall", "isolation"]);
    assert_success(&a_recall);
    let a_recall = String::from_utf8_lossy(&a_recall.stdout);
    assert!(a_recall.contains("alpha isolation"));
    assert!(!a_recall.contains("bravo isolation"));
    assert!(a_recall.contains("placement: repository:"));

    let cross_scope_forget = fixture.run(&fixture.repo_b, &["forget", &a_id.to_string()]);
    assert_success(&cross_scope_forget);
    assert_eq!(cross_scope_forget.stdout, b"not found #1\n");

    let a_list = fixture.run(&fixture.repo_a, &["list"]);
    assert_success(&a_list);
    assert!(String::from_utf8_lossy(&a_list.stdout).contains("alpha isolation"));
}

#[test]
fn placement_selectors_store_identical_content_independently() {
    // Given
    let fixture = CliFixture::new();
    for domain in ["platform/rust", "platform/sqlite"] {
        assert_success(&fixture.run(&fixture.repo_a, &["scope", "domain", "create", domain]));
        assert_success(&fixture.run(&fixture.repo_a, &["scope", "domain", "attach", domain]));
    }

    // When
    let repository = fixture.run(&fixture.repo_a, &["remember", "shared placement value"]);
    let rust_domain = fixture.run(
        &fixture.repo_a,
        &[
            "remember",
            "shared placement value",
            "--domain",
            "platform/rust",
        ],
    );
    let sqlite_domain = fixture.run(
        &fixture.repo_a,
        &[
            "remember",
            "shared placement value",
            "--domain",
            "platform/sqlite",
        ],
    );
    let universal = fixture.run(
        &fixture.repo_a,
        &["remember", "shared placement value", "--universal"],
    );
    let rust_domain_list = fixture.run(&fixture.repo_a, &["list", "--domain", "platform/rust"]);
    let sqlite_domain_list = fixture.run(&fixture.repo_a, &["list", "--domain", "platform/sqlite"]);
    let universal_list = fixture.run(&fixture.repo_a, &["list", "--universal"]);

    // Then
    assert_success(&repository);
    assert_success(&rust_domain);
    assert_success(&sqlite_domain);
    assert_success(&universal);
    for (output, placement) in [
        (&rust_domain_list, "placement: domain:platform/rust"),
        (&sqlite_domain_list, "placement: domain:platform/sqlite"),
        (&universal_list, "placement: universal"),
    ] {
        assert_success(output);
        let output = String::from_utf8_lossy(&output.stdout);
        assert!(output.contains("shared placement value"));
        assert!(output.contains(placement));
    }
}

#[test]
fn domain_selector_requires_attachment_and_mutates_only_its_exact_placement() {
    // Given
    let fixture = CliFixture::new();
    assert_success(&fixture.run(
        &fixture.repo_a,
        &["scope", "domain", "create", "platform/rust"],
    ));

    // When
    let unattached = fixture.run(
        &fixture.repo_a,
        &["remember", "must stay absent", "--domain", "platform/rust"],
    );
    assert_success(&fixture.run(
        &fixture.repo_a,
        &["scope", "domain", "attach", "platform/rust"],
    ));
    let repository = fixture.run(&fixture.repo_a, &["remember", "repository value"]);
    let domain = fixture.run(
        &fixture.repo_a,
        &["remember", "domain value", "--domain", "platform/rust"],
    );
    let universal = fixture.run(
        &fixture.repo_a,
        &["remember", "universal value", "--universal"],
    );
    let wrong_delete = fixture.run(
        &fixture.repo_a,
        &[
            "forget",
            &saved_id(&repository).to_string(),
            "--domain",
            "platform/rust",
        ],
    );

    // Then
    assert_failure(&unattached, "is not attached to this repository");
    assert_success(&repository);
    assert_success(&domain);
    assert_success(&universal);
    assert_success(&wrong_delete);
    assert_eq!(wrong_delete.stdout, b"not found #1\n");
    let domain_list = fixture.run(&fixture.repo_a, &["list", "--domain", "platform/rust"]);
    assert_success(&domain_list);
    let domain_list = String::from_utf8_lossy(&domain_list.stdout);
    assert!(domain_list.contains("domain value"));
    assert!(!domain_list.contains("repository value"));
    assert!(!domain_list.contains("universal value"));
}

#[test]
fn retired_cli_surfaces_and_global_flags_are_rejected() {
    // Given
    let fixture = CliFixture::new();

    // When
    let global_flags = [
        ["remember", "value", "--global"].as_slice(),
        ["recall", "value", "--global"].as_slice(),
        ["list", "--global"].as_slice(),
        ["forget", "1", "--global"].as_slice(),
        ["status", "--global"].as_slice(),
    ];
    let retired_commands = [
        ["scope", "migrate", "--from", "global", "--id", "1"].as_slice(),
        ["install"].as_slice(),
        ["uninstall"].as_slice(),
    ];

    // Then
    for arguments in global_flags {
        assert_failure(
            &fixture.run(&fixture.repo_a, arguments),
            "unexpected argument '--global'",
        );
    }
    for arguments in retired_commands {
        assert_failure(
            &fixture.run(&fixture.repo_a, arguments),
            "unrecognized subcommand",
        );
    }
}

#[test]
fn conflicting_placement_selectors_fail_without_creating_a_database() {
    // Given
    let fixture = CliFixture::new();

    // When
    let conflict = fixture.run(
        &fixture.repo_a,
        &[
            "remember",
            "must not be stored",
            "--domain",
            "platform/rust",
            "--universal",
        ],
    );

    // Then
    assert_failure(&conflict, "cannot be used with");
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

#[test]
fn malformed_repository_config_fails_before_opening_local_database() {
    let fixture = CliFixture::new();
    let configured = Command::new("git")
        .args([
            "config",
            "--local",
            "memocap.repository-id",
            "repository:bad",
        ])
        .current_dir(&fixture.repo_a)
        .output()
        .unwrap();
    assert_success(&configured);

    let failure = fixture.run(&fixture.repo_a, &["remember", "must not open the database"]);

    assert_failure(&failure, "local repository ID configuration is invalid");
    assert!(!fixture.data_dir.join("memocap.db").exists());
    let persisted = Command::new("git")
        .args(["config", "--local", "--get", "memocap.repository-id"])
        .current_dir(&fixture.repo_a)
        .output()
        .unwrap();
    assert_success(&persisted);
    assert_eq!(
        String::from_utf8_lossy(&persisted.stdout).trim(),
        "repository:bad"
    );
}

#[test]
fn remote_remember_uses_v1_without_creating_local_database() {
    // Given
    let fixture = CliFixture::new();
    let remote_database = fixture._temp.path().join("remote.db");
    let (address, server) = remote_server(remote_database, "remote-cli-token", 1);

    // When
    let output = fixture
        .command(
            &fixture.repo_a,
            &fixture.data_dir,
            &["remember", "remote memory"],
        )
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "remote-cli-token")
        .output()
        .unwrap();
    let paths = server.join().unwrap();

    // Then
    assert_success(&output);
    assert_eq!(paths, vec!["/v1/memories/remember"]);
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

#[test]
fn remote_list_without_selector_includes_the_visible_stack() {
    // Given
    let fixture = CliFixture::new();
    let remote_database = fixture._temp.path().join("remote.db");
    let connection = store::open(&remote_database).unwrap();
    store::remember_at(
        &connection,
        &PlacementId::Universal,
        "remote universal memory",
        "context",
        "",
        RememberOptions {
            topic_key: None,
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    let (address, server) = remote_server(remote_database, "remote-cli-token", 1);

    // When
    let output = fixture
        .command(&fixture.repo_a, &fixture.data_dir, &["list"])
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "remote-cli-token")
        .output()
        .unwrap();
    let paths = server.join().unwrap();

    // Then
    assert_success(&output);
    assert_eq!(paths, vec!["/v1/memories/list"]);
    assert!(String::from_utf8_lossy(&output.stdout).contains("remote universal memory"));
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

#[test]
fn remote_scope_commands_use_v1_without_creating_local_database() {
    let fixture = CliFixture::new();
    let remote_database = fixture._temp.path().join("remote.db");
    let repository = memocap::scope::resolve(&fixture.repo_a)
        .unwrap()
        .repository()
        .to_string();
    let (address, server) = remote_server(remote_database, "remote-cli-token", 9);
    let execute = |arguments: &[&str]| {
        fixture
            .command(&fixture.repo_a, &fixture.data_dir, arguments)
            .env("MEMOCAP_ADDR", &address)
            .env("MEMOCAP_TOKEN", "remote-cli-token")
            .output()
            .unwrap()
    };

    let created = execute(&["scope", "domain", "create", "engineering/rust"]);
    let attached = execute(&["scope", "domain", "attach", "engineering/rust"]);
    let shown = execute(&["scope", "show"]);
    let remembered = execute(&[
        "remember",
        "remote domain memory",
        "--domain",
        "engineering/rust",
    ]);
    let copied = execute(&[
        "scope",
        "copy",
        "--id",
        "1",
        "--from",
        "domain:engineering/rust",
        "--to",
        "universal",
        "--operation-id",
        "00000000-0000-0000-0000-000000000801",
    ]);
    let moved = execute(&[
        "scope",
        "move",
        "--id",
        "2",
        "--from",
        "universal",
        "--to",
        &repository,
        "--yes",
        "--operation-id",
        "00000000-0000-0000-0000-000000000802",
    ]);
    let detached = execute(&["scope", "domain", "detach", "engineering/rust"]);
    let unused_created = execute(&["scope", "domain", "create", "engineering/unused"]);
    let deleted = execute(&["scope", "domain", "delete", "engineering/unused"]);
    let paths = server.join().unwrap();

    for (name, output) in [
        ("create", &created),
        ("attach", &attached),
        ("show", &shown),
        ("remember", &remembered),
        ("copy", &copied),
        ("move", &moved),
        ("detach", &detached),
        ("create unused", &unused_created),
        ("delete", &deleted),
    ] {
        assert!(
            output.status.success(),
            "{name}: stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(String::from_utf8_lossy(&shown.stdout).contains("engineering/rust"));
    assert!(String::from_utf8_lossy(&copied.stdout).contains("operation_id:"));
    assert!(String::from_utf8_lossy(&moved.stdout).contains("operation_id:"));
    assert_eq!(
        paths,
        vec![
            "/v1/domains/create",
            "/v1/domains/attach",
            "/v1/status",
            "/v1/memories/remember",
            "/v1/memories/copy",
            "/v1/memories/move",
            "/v1/domains/detach",
            "/v1/domains/create",
            "/v1/domains/delete",
        ]
    );
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

#[test]
fn remote_operation_status_reads_a_committed_recovery_handle() {
    let fixture = CliFixture::new();
    let remote_database = fixture._temp.path().join("remote.db");
    let repository = memocap::scope::resolve(&fixture.repo_a)
        .unwrap()
        .repository()
        .clone();
    let source = PlacementId::Repository(repository.clone());
    let mut connection = store::open(&remote_database).unwrap();
    let source_id = store::remember_at(
        &connection,
        &source,
        "recoverable remote copy",
        "context",
        "",
        RememberOptions {
            topic_key: None,
            force: false,
            overwrite_id: None,
        },
    )
    .unwrap();
    let request = store::CopyMoveRequest::prepare(
        repository,
        store::CopyMoveInput {
            action: store::CopyMoveAction::Copy,
            memory_id: source_id,
            from: source,
            to: PlacementId::Universal,
            operation_id: Some("00000000-0000-0000-0000-000000000901".parse().unwrap()),
            applicability_note: None,
        },
    )
    .unwrap();
    let recovery = memocap::remote::RecoveryHandle::from_request(&request).unwrap();
    let committed = store::copy_move(&mut connection, request).unwrap();
    let (address, server) = remote_server(remote_database, "remote-cli-token", 1);

    let output = fixture
        .command(
            &fixture.repo_a,
            &fixture.data_dir,
            &["operation", "status", "--recovery", &recovery.to_string()],
        )
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "remote-cli-token")
        .output()
        .unwrap();
    let paths = server.join().unwrap();

    assert_success(&output);
    assert_eq!(paths, vec!["/v1/operations/status"]);
    let output = String::from_utf8_lossy(&output.stdout);
    assert!(output.contains(&format!("#{}", committed.memory_id)));
    assert!(output.contains("operation_id:"));
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

#[test]
fn unavailable_remote_operation_status_reports_unknown_without_local_database() {
    let fixture = CliFixture::new();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let recovery = format!(
        "operation-recovery:v1:{}:00000000-0000-0000-0000-000000000902:{}",
        "0".repeat(64),
        "a".repeat(64),
    );

    let output = fixture
        .command(
            &fixture.repo_a,
            &fixture.data_dir,
            &["operation", "status", "--recovery", &recovery],
        )
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "remote-cli-token")
        .output()
        .unwrap();

    assert_success(&output);
    assert_eq!(output.stdout, b"outcome unknown\n");
    assert!(!fixture.data_dir.join("memocap.db").exists());
}

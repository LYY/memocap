use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

struct Fixture {
    _directory: tempfile::TempDir,
    data: PathBuf,
    home: PathBuf,
    repository: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let home = directory.path().join("home");
        let repository = directory.path().join("repository");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repository).unwrap();
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&repository)
            .status()
            .unwrap();
        assert!(initialized.success());
        Self {
            _directory: directory,
            data,
            home,
            repository,
        }
    }

    fn run(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_memocap"))
            .args(arguments)
            .current_dir(&self.repository)
            .env("MEMOCAP_DATA_DIR", &self.data)
            .env("MEMOCAP_HOME", &self.home)
            .env_remove("MEMOCAP_ADDR")
            .env_remove("MEMOCAP_URL")
            .env_remove("MEMOCAP_ADDRESS")
            .env_remove("MEMOCAP_TOKEN")
            .output()
            .unwrap()
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        stdout(output),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn scope_domain_create_is_idempotent_and_list_all_includes_unattached_domains() {
    // Given
    let fixture = Fixture::new();

    // When
    let first = fixture.run(&["scope", "domain", "create", "platform/rust"]);
    let duplicate = fixture.run(&["scope", "domain", "create", "platform/rust"]);
    let second = fixture.run(&["scope", "domain", "create", "platform/sqlite"]);
    let attached = fixture.run(&["scope", "domain", "list"]);
    let all = fixture.run(&["scope", "domain", "list", "--all"]);

    // Then
    for output in [&first, &duplicate, &second, &attached, &all] {
        assert_success(output);
    }
    assert_eq!(stdout(&first), "created domain platform/rust\n");
    assert_eq!(stdout(&duplicate), "domain already exists platform/rust\n");
    assert_eq!(stdout(&second), "created domain platform/sqlite\n");
    assert_eq!(stdout(&attached), "No domains found.\n");
    assert_eq!(stdout(&all), "platform/rust\nplatform/sqlite\n");
}

#[test]
fn scope_domain_attach_before_is_visible_in_list_and_scope_show_after_reopen() {
    // Given
    let fixture = Fixture::new();
    for domain in ["platform/rust", "platform/sqlite"] {
        assert_success(&fixture.run(&["scope", "domain", "create", domain]));
    }

    // When
    let attached_rust = fixture.run(&["scope", "domain", "attach", "platform/rust"]);
    let attached_sqlite = fixture.run(&[
        "scope",
        "domain",
        "attach",
        "platform/sqlite",
        "--before",
        "platform/rust",
    ]);
    let duplicate = fixture.run(&["scope", "domain", "attach", "platform/sqlite"]);
    let listed = fixture.run(&["scope", "domain", "list"]);
    let shown = fixture.run(&["scope", "show"]);

    // Then
    for output in [
        &attached_rust,
        &attached_sqlite,
        &duplicate,
        &listed,
        &shown,
    ] {
        assert_success(output);
    }
    assert_eq!(stdout(&attached_rust), "attached domain platform/rust\n");
    assert_eq!(
        stdout(&attached_sqlite),
        "attached domain platform/sqlite\n"
    );
    assert_eq!(
        stdout(&duplicate),
        "domain already attached platform/sqlite\n"
    );
    assert_eq!(stdout(&listed), "platform/sqlite\nplatform/rust\n");
    let shown = stdout(&shown);
    assert!(shown.contains("repository_id: repository:"));
    assert!(shown.contains("attached_domains:\n- platform/sqlite\n- platform/rust\n"));
}

#[test]
fn scope_domain_detach_and_delete_report_registry_and_binding_state() {
    // Given
    let fixture = Fixture::new();
    assert_success(&fixture.run(&["scope", "domain", "create", "platform/rust"]));
    assert_success(&fixture.run(&["scope", "domain", "attach", "platform/rust"]));

    // When
    let detached = fixture.run(&["scope", "domain", "detach", "platform/rust"]);
    let detached_again = fixture.run(&["scope", "domain", "detach", "platform/rust"]);
    let all_before_delete = fixture.run(&["scope", "domain", "list", "--all"]);
    let deleted = fixture.run(&["scope", "domain", "delete", "platform/rust"]);
    let deleted_again = fixture.run(&["scope", "domain", "delete", "platform/rust"]);

    // Then
    for output in [
        &detached,
        &detached_again,
        &all_before_delete,
        &deleted,
        &deleted_again,
    ] {
        assert_success(output);
    }
    assert_eq!(stdout(&detached), "detached domain platform/rust\n");
    assert_eq!(
        stdout(&detached_again),
        "domain not attached platform/rust\n"
    );
    assert_eq!(stdout(&all_before_delete), "platform/rust\n");
    assert_eq!(stdout(&deleted), "deleted domain platform/rust\n");
    assert_eq!(stdout(&deleted_again), "domain not found platform/rust\n");
}

#[test]
fn scope_domain_rejects_malformed_ids_before_creating_a_database() {
    // Given
    let fixture = Fixture::new();

    // When
    let invalid = fixture.run(&["scope", "domain", "create", "Platform/Rust"]);

    // Then
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("invalid value"));
    assert!(!fixture.data.join("memocap.db").exists());
}

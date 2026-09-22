use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::mpsc,
    thread,
};

use memocap::{
    cli,
    scope::{DomainId, PlacementId, RepositoryId},
    store::{self, CopyMoveAction, CopyMoveInput},
};

struct Fixture {
    _temporary: tempfile::TempDir,
    data: PathBuf,
    home: PathBuf,
    repository: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let data = temporary.path().join("data");
        let home = temporary.path().join("home");
        let repository = temporary.path().join("repository");
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
            _temporary: temporary,
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

    fn database(&self) -> PathBuf {
        self.data.join("memocap.db")
    }

    fn repository_id(&self) -> String {
        let output = Command::new("git")
            .args(["config", "--local", "--get", "memocap.repository-id"])
            .current_dir(&self.repository)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_failure(output: &Output, message: &str) {
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains(message));
}

fn saved_id(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .strip_prefix("saved #")
        .unwrap()
        .to_owned()
}

fn copied_id(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap()
        .strip_prefix("copied #")
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn omitted_copy_operation_id_replays_across_fresh_processes_without_duplicate_rows() {
    // Given
    let fixture = Fixture::new();
    let source = fixture.run(&["remember", "default operation source", "--force"]);
    assert_success(&source);
    let source_id = saved_id(&source);
    let repository = fixture.repository_id();

    // When
    let copied = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
    ]);
    let replayed = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
    ]);

    // Then
    assert_success(&copied);
    assert_success(&replayed);
    assert_eq!(copied.stdout, replayed.stdout);
    let database = rusqlite::Connection::open(fixture.database()).unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn copy_replays_once_then_move_retains_id_and_provenance() {
    // Given
    let fixture = Fixture::new();
    let source = fixture.run(&["remember", "copy source", "--force"]);
    assert_success(&source);
    let source_id = saved_id(&source);
    let repository = fixture.repository_id();
    assert_success(&fixture.run(&["scope", "domain", "create", "team/rust"]));
    assert_success(&fixture.run(&["scope", "domain", "attach", "team/rust"]));
    let copy_operation = "00000000-0000-0000-0000-000000000101";
    let copy = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/rust",
        "--operation-id",
        copy_operation,
        "--note",
        "shared runtime guidance",
    ]);

    // When
    assert_success(&copy);
    let copied_id = copied_id(&copy);
    let replay = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/rust",
        "--operation-id",
        copy_operation,
        "--note",
        "shared runtime guidance",
    ]);
    let move_operation = "00000000-0000-0000-0000-000000000102";
    let moved = fixture.run(&[
        "scope",
        "move",
        "--id",
        &copied_id,
        "--from",
        "domain:team/rust",
        "--to",
        "universal",
        "--yes",
        "--operation-id",
        move_operation,
    ]);

    // Then
    assert_success(&replay);
    assert_eq!(copy.stdout, replay.stdout);
    assert_success(&moved);
    assert!(String::from_utf8_lossy(&moved.stdout).starts_with(&format!("moved #{copied_id}")));
    let database = rusqlite::Connection::open(fixture.database()).unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row(
                "SELECT placement_kind FROM memories WHERE id = ?1",
                [&copied_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "universal"
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row(
                "SELECT action FROM memory_provenance WHERE memory_id = ?1",
                [&copied_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "copy"
    );
}

#[test]
fn committed_copy_and_move_replay_after_domain_detach_without_new_mutations() {
    // Given
    let fixture = Fixture::new();
    let source = fixture.run(&["remember", "detached replay source", "--force"]);
    assert_success(&source);
    let source_id = saved_id(&source);
    let repository = fixture.repository_id();
    assert_success(&fixture.run(&["scope", "domain", "create", "team/replay"]));
    assert_success(&fixture.run(&["scope", "domain", "attach", "team/replay"]));
    let copy_operation = "00000000-0000-0000-0000-000000000104";
    let copy = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/replay",
        "--operation-id",
        copy_operation,
        "--note",
        "replay note",
    ]);
    assert_success(&copy);
    let copied_id = copied_id(&copy);
    let move_operation = "00000000-0000-0000-0000-000000000105";
    let moved = fixture.run(&[
        "scope",
        "move",
        "--id",
        &copied_id,
        "--from",
        "domain:team/replay",
        "--to",
        "universal",
        "--yes",
        "--operation-id",
        move_operation,
    ]);
    assert_success(&moved);
    assert_success(&fixture.run(&["scope", "domain", "detach", "team/replay"]));

    // When
    let copy_replay = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/replay",
        "--operation-id",
        copy_operation,
        "--note",
        "replay note",
    ]);
    let move_replay = fixture.run(&[
        "scope",
        "move",
        "--id",
        &copied_id,
        "--from",
        "domain:team/replay",
        "--to",
        "universal",
        "--yes",
        "--operation-id",
        move_operation,
    ]);
    let changed_note = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/replay",
        "--operation-id",
        copy_operation,
        "--note",
        "changed note",
    ]);
    let changed_destination = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
        "--operation-id",
        copy_operation,
        "--note",
        "replay note",
    ]);
    let new_detached_destination = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/replay",
    ]);
    let new_detached_source = fixture.run(&[
        "scope",
        "move",
        "--id",
        &copied_id,
        "--from",
        "domain:team/replay",
        "--to",
        "universal",
        "--yes",
    ]);
    let new_missing_source = fixture.run(&[
        "scope",
        "copy",
        "--id",
        "999",
        "--from",
        &repository,
        "--to",
        "universal",
    ]);

    // Then
    assert_success(&copy_replay);
    assert_eq!(copy.stdout, copy_replay.stdout);
    assert_success(&move_replay);
    assert_eq!(moved.stdout, move_replay.stdout);
    assert_failure(&changed_note, "operation ID conflict");
    assert_failure(&changed_destination, "operation ID conflict");
    assert_failure(
        &new_detached_destination,
        "is not attached to this repository",
    );
    assert_failure(&new_detached_source, "is not attached to this repository");
    assert_failure(&new_missing_source, "not found in source placement");
    let database = rusqlite::Connection::open(fixture.database()).unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row(
                "SELECT COUNT(*) FROM repository_domain_attachments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn copy_move_rejects_conflict_unattached_invalid_and_unconfirmed_requests_without_state() {
    // Given
    let fixture = Fixture::new();
    let source = fixture.run(&["remember", "guarded source", "--force"]);
    assert_success(&source);
    let source_id = saved_id(&source);
    let repository = fixture.repository_id();
    assert_success(&fixture.run(&["scope", "domain", "create", "team/unattached"]));
    let operation = "00000000-0000-0000-0000-000000000103";
    let copied = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
        "--operation-id",
        operation,
    ]);
    assert_success(&copied);

    // When
    let conflict = fixture.run(&[
        "scope",
        "move",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
        "--yes",
        "--operation-id",
        operation,
    ]);
    let unattached = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "domain:team/unattached",
    ]);
    let malformed = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        "not-a-placement",
        "--to",
        "universal",
    ]);
    let unconfirmed = fixture.run(&[
        "scope",
        "move",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        "universal",
    ]);
    let same_placement = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        &repository,
    ]);
    let foreign_repository = format!("repository:{}", "b".repeat(64));
    let foreign_source = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &foreign_repository,
        "--to",
        "universal",
    ]);
    let foreign_destination = fixture.run(&[
        "scope",
        "copy",
        "--id",
        &source_id,
        "--from",
        &repository,
        "--to",
        &foreign_repository,
    ]);

    // Then
    assert_failure(&conflict, "operation ID conflict");
    assert_failure(&unattached, "is not attached to this repository");
    assert_failure(&malformed, "invalid placement ID");
    assert_failure(&unconfirmed, "requires --yes");
    assert_failure(
        &same_placement,
        "source and destination placements must differ",
    );
    assert_failure(
        &foreign_source,
        "repository placement must match the current repository",
    );
    assert_failure(
        &foreign_destination,
        "repository placement must match the current repository",
    );
    let database = rusqlite::Connection::open(fixture.database()).unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM operation_ledger", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM memory_provenance", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn local_copy_rejects_destination_detached_before_store_without_mutation() {
    // Given
    let fixture = Fixture::new();
    let source = fixture.run(&["remember", "local handoff source", "--force"]);
    assert_success(&source);
    let source_id = saved_id(&source).parse::<i64>().unwrap();
    let repository = fixture.repository_id().parse::<RepositoryId>().unwrap();
    let destination = "transfer/local-handoff".parse::<DomainId>().unwrap();
    let database = fixture.database();
    let mut connection = store::open(&database).unwrap();
    assert!(store::create_domain(&mut connection, &destination).unwrap());
    assert!(store::attach_domain(&mut connection, &repository, &destination, None).unwrap());
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let (release_sender, release_receiver) = mpsc::sync_channel(1);
    let transfer_database = database.clone();
    let transfer_repository = repository.clone();
    let transfer_destination = destination.clone();
    let transfer = thread::spawn(move || {
        ready_sender.send(()).unwrap();
        release_receiver.recv().unwrap();
        cli::copy_move(
            &transfer_database,
            &transfer_repository,
            CopyMoveInput {
                action: CopyMoveAction::Copy,
                memory_id: source_id,
                from: PlacementId::Repository(transfer_repository.clone()),
                to: PlacementId::Domain(transfer_destination),
                operation_id: Some("00000000-0000-0000-0000-000000000201".parse().unwrap()),
                applicability_note: None,
            },
        )
    });
    ready_receiver.recv().unwrap();
    assert!(store::detach_domain(&mut connection, &repository, &destination).unwrap());

    // When
    release_sender.send(()).unwrap();
    let failure = transfer.join().unwrap().unwrap_err();

    // Then
    assert_eq!(
        failure.to_string(),
        "domain transfer/local-handoff is not attached to this repository"
    );
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

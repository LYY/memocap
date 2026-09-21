use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

use rusqlite::Connection;

struct Fixture {
    _temp: tempfile::TempDir,
    data_dir: PathBuf,
    home: PathBuf,
    repository: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let home = temp.path().join("home");
        let repository = temp.path().join("repository");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repository).unwrap();
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&repository)
            .status()
            .unwrap();
        assert!(initialized.success());
        Self {
            _temp: temp,
            data_dir,
            home,
            repository,
        }
    }

    fn run(&self, arguments: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_memocap"))
            .args(arguments)
            .current_dir(&self.repository)
            .env("MEMOCAP_DATA_DIR", &self.data_dir)
            .env("MEMOCAP_HOME", &self.home)
            .env_remove("MEMOCAP_ADDR")
            .env_remove("MEMOCAP_TOKEN")
            .output()
            .unwrap()
    }
}

fn success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn saved_id(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .strip_prefix("saved #")
        .unwrap()
        .to_owned()
}

fn output_text(output: Output) -> String {
    success(&output);
    String::from_utf8(output.stdout).unwrap()
}

fn position(text: &str, needle: &str) -> usize {
    text.find(needle)
        .unwrap_or_else(|| panic!("{needle:?} missing from {text:?}"))
}

#[test]
fn default_recall_list_and_status_explain_the_visible_stack() {
    // Given
    let fixture = Fixture::new();
    for domain in ["engineering/rust", "engineering/sqlite"] {
        success(&fixture.run(&["scope", "domain", "create", domain]));
        success(&fixture.run(&["scope", "domain", "attach", domain]));
    }
    success(&fixture.run(&[
        "remember",
        "alpha repository weak result",
        "--topic",
        "RÜST STATUS",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha first-domain hidden result",
        "--domain",
        "engineering/rust",
        "--topic",
        "rüst status",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha first-domain collision result",
        "--domain",
        "engineering/rust",
        "--topic",
        "collision",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha second-domain collision result",
        "--domain",
        "engineering/sqlite",
        "--topic",
        "collision",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha universal hidden repository result",
        "--universal",
        "--topic",
        "rüst status",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha universal hidden domain result",
        "--universal",
        "--topic",
        "collision",
    ]));
    success(&fixture.run(&[
        "remember",
        "alpha alpha alpha universal strong unkeyed result",
        "--universal",
        "--topic",
        "  ",
    ]));

    // When
    let recall = output_text(fixture.run(&["recall", "alpha", "--limit", "20"]));
    let limited =
        output_text(fixture.run(&["recall", "alpha", "--limit", "1", "--max-chars", "0"]));
    let list = output_text(fixture.run(&["list", "--limit", "20"]));
    let status = output_text(fixture.run(&["status"]));

    // Then
    assert!(recall.contains("alpha repository weak result"));
    assert!(recall.contains("alpha first-domain collision result"));
    assert!(recall.contains("alpha second-domain collision result"));
    assert!(recall.contains("alpha alpha alpha universal strong unkeyed result"));
    assert!(!recall.contains("alpha first-domain hidden result"));
    assert!(!recall.contains("alpha universal hidden repository result"));
    assert!(!recall.contains("alpha universal hidden domain result"));
    assert!(
        position(&recall, "alpha repository weak result")
            < position(&recall, "alpha first-domain collision result")
    );
    assert!(
        position(&recall, "alpha first-domain collision result")
            < position(&recall, "alpha second-domain collision result")
    );
    assert!(
        position(&recall, "alpha second-domain collision result")
            < position(&recall, "alpha alpha alpha universal strong unkeyed result")
    );
    assert!(recall.contains("source_order: 0"));
    assert!(recall.contains("visibility: visible"));
    assert!(limited.contains("alpha repository weak result"));
    assert!(!limited.contains("alpha first-domain collision result"));
    assert!(list.contains("alpha first-domain hidden result"));
    assert!(list.contains("alpha universal hidden repository result"));
    assert!(list.contains("visibility: shadowed"));
    assert!(list.contains("shadowed_by: source 0"));
    assert!(list.contains("shadowed_by: source 1"));
    assert!(status.contains("schema_version: 1.0"));
    assert!(status.contains("addressable_total: 7"));
    assert!(status.contains("effective_total: 4"));
    assert_eq!(
        Connection::open(fixture.data_dir.join("memocap.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        7
    );
}

#[test]
fn deleting_a_more_specific_topic_restores_the_next_visible_source() {
    // Given
    let fixture = Fixture::new();
    success(&fixture.run(&["scope", "domain", "create", "engineering/rust"]));
    success(&fixture.run(&["scope", "domain", "attach", "engineering/rust"]));
    let repository = fixture.run(&[
        "remember",
        "release repository result",
        "--topic",
        "release",
    ]);
    let domain = fixture.run(&[
        "remember",
        "release domain result",
        "--domain",
        "engineering/rust",
        "--topic",
        "release",
    ]);
    success(&fixture.run(&[
        "remember",
        "release universal result",
        "--universal",
        "--topic",
        "release",
    ]));

    // When
    let before = output_text(fixture.run(&["recall", "release", "--limit", "20"]));
    success(&repository);
    success(&domain);
    success(&fixture.run(&["forget", &saved_id(&repository)]));
    let after_repository_delete = output_text(fixture.run(&["recall", "release", "--limit", "20"]));
    success(&fixture.run(&["forget", &saved_id(&domain), "--domain", "engineering/rust"]));
    let after_domain_delete = output_text(fixture.run(&["recall", "release", "--limit", "20"]));

    // Then
    assert!(before.contains("release repository result"));
    assert!(!before.contains("release domain result"));
    assert!(!before.contains("release universal result"));
    assert!(after_repository_delete.contains("release domain result"));
    assert!(!after_repository_delete.contains("release universal result"));
    assert!(after_domain_delete.contains("release universal result"));
}

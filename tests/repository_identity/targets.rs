use super::*;

#[test]
fn public_cli_remember_captures_current_descriptor() {
    // Given
    const DRIVER: &str = "MEMOCAP_TEST_IDENTITY_DATABASE";
    if let Some(database) = std::env::var_os(DRIVER) {
        memocap::cli::remember_placed(
            std::path::Path::new(&database),
            None,
            memocap::cli::ScopedRemember {
                content: "public API memory",
                kind: "note",
                tags: "",
                topic: None,
                force: true,
                overwrite_id: None,
            },
        )
        .unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let checkout = root.path().join("public-cli-project");
    std::fs::create_dir(&checkout).unwrap();
    let database = root.path().join("core.db");
    // When
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "targets::public_cli_remember_captures_current_descriptor",
        ])
        .current_dir(&checkout)
        .env(DRIVER, &database)
        .output()
        .unwrap();
    // Then
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let connection = Connection::open(&database).unwrap();
    let name: String = connection
        .query_row(
            "SELECT display_name FROM repository_identities",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(name, "public-cli-project");
}

#[test]
fn human_read_uses_persisted_name_without_a_checkout() {
    // Given
    let fixture = observable::Fixture::new();
    execute(
        &fixture.database,
        &request(remember(None), descriptor("durable/project", None)),
    );
    // When
    let output = fixture
        .command(&["--repository-id", REPO, "list"])
        .output()
        .unwrap();
    // Then
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("durable/project"), "{text}");
    assert!(text.contains(REPO));
}

#[test]
fn frozen_target_keeps_identity_after_path_disappears() {
    // Given
    let fixture = observable::Fixture::new();
    let resolved = fixture.json(
        &[
            "--json",
            "--repo",
            fixture.b.to_str().unwrap(),
            "scope",
            "resolve",
        ],
        true,
    );
    let targets = resolved["targets"].to_string();
    let repository = resolved["targets"][0]["repository_id"].as_str().unwrap();
    std::fs::remove_dir(&fixture.b).unwrap();
    // When
    let saved = fixture.json(
        &[
            "--json",
            "--targets-json",
            &targets,
            "remember",
            "frozen memory",
        ],
        true,
    );
    let read = fixture.json(&["--json", "--repository-id", repository, "list"], true);
    // Then
    assert_eq!(saved["targets"][0]["repository_id"], repository);
    assert_eq!(read["results"][0]["memory"]["content"], "frozen memory");
    assert_eq!(
        read["repository_context"][repository]["identity"]["display_name"],
        "b"
    );
}

#[test]
fn pinned_id_does_not_hide_current_verified_remote_descriptor() {
    // Given
    let fixture = observable::Fixture::new();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .args(args)
            .current_dir(&fixture.b)
            .status()
            .unwrap()
            .success());
    };
    git(&["init", "--quiet"]);
    git(&["config", "--local", "memocap.repository-id", REPO]);
    git(&[
        "config",
        "--local",
        "remote.origin.url",
        "git@EXAMPLE.com:Team/Actual.git",
    ]);
    let before = std::fs::read(fixture.b.join(".git/config")).unwrap();
    // When
    let resolved = fixture.json(
        &[
            "--json",
            "--repo",
            fixture.b.to_str().unwrap(),
            "scope",
            "resolve",
        ],
        true,
    );
    // Then
    assert_eq!(resolved["targets"][0]["repository_id"], REPO);
    assert_eq!(
        resolved["targets"][0]["descriptor"]["display_name"],
        "Team/Actual"
    );
    assert_eq!(
        resolved["targets"][0]["descriptor"]["normalized_remote"],
        "example.com/Team/Actual"
    );
    assert_eq!(
        std::fs::read(fixture.b.join(".git/config")).unwrap(),
        before
    );
}

#[test]
fn selectors_reject_conflicts_and_multiple_writers() {
    // Given
    let fixture = observable::Fixture::new();
    // When
    let conflict = fixture.json(
        &[
            "--json",
            "--repository-id",
            REPO,
            "--repo",
            fixture.b.to_str().unwrap(),
            "list",
        ],
        false,
    );
    let multiple = fixture.json(
        &[
            "--json",
            "--repository-id",
            REPO,
            "--repository-id",
            "repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "remember",
            "no write",
        ],
        false,
    );
    // Then
    assert_eq!(conflict["status"], "failed");
    assert_eq!(multiple["status"], "failed");
    assert!(!fixture.database.exists());
}

#[test]
fn resolution_keeps_distinct_paths_with_the_same_repository_id() {
    // Given
    let fixture = observable::Fixture::new();
    for path in [&fixture.a, &fixture.b] {
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "--local", "memocap.repository-id", REPO],
        ] {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(path)
                .status()
                .unwrap()
                .success());
        }
    }
    // When
    let resolved = fixture.json(
        &[
            "--json",
            "--repo",
            fixture.a.to_str().unwrap(),
            "--repo",
            fixture.b.to_str().unwrap(),
            "scope",
            "resolve",
        ],
        true,
    );
    // Then
    assert_eq!(resolved["targets"].as_array().unwrap().len(), 2);
}

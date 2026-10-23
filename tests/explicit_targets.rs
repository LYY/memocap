use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

#[path = "explicit_targets/query.rs"]
mod query;
#[path = "explicit_targets/remote.rs"]
mod remote;

struct Fixture {
    root: tempfile::TempDir,
    a: PathBuf,
    b: PathBuf,
    outside: PathBuf,
    database: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        let outside = root.path().join("outside");
        for path in [&a, &b, &outside] {
            fs::create_dir(path).unwrap();
        }
        let database = root.path().join("memocap.db");
        Self {
            root,
            a,
            b,
            outside,
            database,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
        command
            .current_dir(&self.outside)
            .env("MEMOCAP_DB", &self.database)
            .env("MEMOCAP_DATA_DIR", self.root.path())
            .env("MEMOCAP_HOME", self.root.path())
            .env_remove("MEMOCAP_ADDR")
            .env_remove("MEMOCAP_TOKEN")
            .env_remove("MEMOCAP_URL")
            .env_remove("MEMOCAP_ADDRESS");
        command
    }

    fn run(&self, arguments: &[&str]) -> Output {
        self.command().args(arguments).output().unwrap()
    }

    fn at(&self, path: &std::path::Path, arguments: &[&str]) -> String {
        let mut args = vec!["--repo", path.to_str().unwrap()];
        args.extend_from_slice(arguments);
        text(self.run(&args))
    }
}

fn text(output: Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn explicit_writes_and_reads_use_the_target_instead_of_the_process_directory() {
    let fixture = Fixture::new();
    fixture.at(&fixture.a, &["remember", "alphaonly record"]);
    fixture.at(&fixture.b, &["remember", "betaonly record"]);

    let a = fixture.at(&fixture.a, &["list"]);
    let b = fixture.at(&fixture.b, &["list"]);
    let outside = text(fixture.run(&["list"]));

    assert!(a.contains("alphaonly record"));
    assert!(!a.contains("betaonly record"));
    assert!(b.contains("betaonly record"));
    assert!(!b.contains("alphaonly record"));
    assert!(!outside.contains("only record"));
}

#[test]
fn multi_recall_preserves_per_repository_shadowing_and_deduplicates_shared_records() {
    let fixture = Fixture::new();
    fixture.at(
        &fixture.a,
        &[
            "remember",
            "release universal",
            "--universal",
            "--topic",
            "policy",
        ],
    );
    fixture.at(
        &fixture.a,
        &["remember", "release override", "--topic", "policy"],
    );
    fixture.at(&fixture.b, &["remember", "release beta"]);
    fixture.at(
        &fixture.a,
        &["remember", "release shared", "--universal", "--force"],
    );

    let merged = text(fixture.run(&[
        "recall",
        "release",
        "--repo",
        fixture.a.to_str().unwrap(),
        "--repo",
        fixture.b.to_str().unwrap(),
        "--limit",
        "20",
    ]));

    for content in [
        "release override",
        "release universal",
        "release beta",
        "release shared",
    ] {
        assert_eq!(merged.matches(content).count(), 1, "{merged}");
    }
    assert!(merged.find("release override").unwrap() < merged.find("release beta").unwrap());
    fixture.at(&fixture.a, &["remember", "aftermulti single", "--force"]);
    assert!(!fixture
        .at(&fixture.b, &["list"])
        .contains("aftermulti single"));
}

#[test]
fn match_any_expands_lexical_recall_while_default_requires_all_terms() {
    let fixture = Fixture::new();
    fixture.at(&fixture.a, &["remember", "apple only", "--tags", "水果"]);
    fixture.at(&fixture.a, &["remember", "pear only"]);
    fixture.at(&fixture.a, &["remember", "apple pear combined", "--force"]);

    let all = fixture.at(&fixture.a, &["recall", "apple pear"]);
    let any = fixture.at(&fixture.a, &["recall", "apple pear", "--match", "any"]);
    let unicode = fixture.at(&fixture.a, &["recall", "水果 absent", "--match", "any"]);

    assert!(all.contains("apple pear combined"));
    assert!(!all.contains("apple only"));
    assert!(any.contains("apple only"));
    assert!(any.contains("pear only"));
    assert!(unicode.contains("apple only"));
}

#[test]
fn invalid_targets_are_rejected_before_opening_or_mutating_the_database() {
    let fixture = Fixture::new();
    let missing = fixture.root.path().join("missing");
    let file = fixture.root.path().join("file");
    fs::write(&file, "file").unwrap();

    for path in [&missing, &file] {
        let output = fixture.run(&[
            "remember",
            "must not save",
            "--repo",
            path.to_str().unwrap(),
        ]);
        assert!(!output.status.success());
        assert!(!fixture.database.exists());
    }
    let repeated = fixture.run(&[
        "remember",
        "must not save",
        "--repo",
        fixture.a.to_str().unwrap(),
        "--repo",
        fixture.b.to_str().unwrap(),
    ]);
    assert!(!repeated.status.success());
    assert!(!fixture.database.exists());
    let invalid_second = fixture.run(&[
        "recall",
        "query",
        "--repo",
        fixture.a.to_str().unwrap(),
        "--repo",
        missing.to_str().unwrap(),
    ]);
    assert!(!invalid_second.status.success());
    assert!(!fixture.database.exists());
    let mut arguments = vec!["recall", "query"];
    for _ in 0..9 {
        arguments.extend(["--repo", fixture.a.to_str().unwrap()]);
    }
    assert!(!fixture.run(&arguments).status.success());
    assert!(!fixture.database.exists());
}

#[test]
fn explicit_domain_selection_requires_attachment_to_the_target() {
    let fixture = Fixture::new();
    fixture.at(
        &fixture.a,
        &["scope", "domain", "create", "engineering/rust"],
    );
    fixture.at(
        &fixture.a,
        &["scope", "domain", "attach", "engineering/rust"],
    );
    fixture.at(
        &fixture.a,
        &["remember", "domainrecord", "--domain", "engineering/rust"],
    );

    let rejected = fixture.run(&[
        "recall",
        "domainrecord",
        "--repo",
        fixture.b.to_str().unwrap(),
        "--domain",
        "engineering/rust",
    ]);

    assert!(!rejected.status.success());
    assert!(fixture
        .at(&fixture.a, &["recall", "domainrecord"])
        .contains("domainrecord"));
}

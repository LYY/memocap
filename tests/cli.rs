use memocap::cli;
use memocap::config;
use memocap::server;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn db() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("db");
    (d, p)
}

#[test]
fn save() {
    let (_d, db) = db();
    let id = cli::remember(&db, "alpha", "note", "t1", false, None).unwrap();
    assert!(id > 0);
    assert_eq!(cli::count(&db).unwrap(), 1);
}

#[test]
fn query() {
    let (_d, db) = db();
    cli::remember(&db, "alpha beta", "note", "", false, None).unwrap();
    let found = cli::recall(&db, "alpha", 5, None, None).unwrap();
    assert_eq!(found.len(), 1);
}

#[test]
fn list_newest() {
    let (_d, db) = db();
    let a = cli::remember(&db, "first", "note", "", false, None).unwrap();
    let b = cli::remember(&db, "second", "note", "", false, None).unwrap();
    let listed = cli::list(&db, 20).unwrap();
    assert_eq!(listed[0].id, b);
    assert_eq!(listed[1].id, a);
}

#[test]
fn delete_target() {
    let (_d, db) = db();
    let keep = cli::remember(&db, "keep", "note", "", false, None).unwrap();
    let drop = cli::remember(&db, "drop", "note", "", false, None).unwrap();
    assert!(cli::forget(&db, drop).unwrap());
    assert_eq!(cli::list(&db, 20).unwrap()[0].id, keep);
}

#[test]
fn empty_store() {
    let (_d, db) = db();
    let listed = cli::list(&db, 20).unwrap();
    assert!(listed.is_empty());
    assert_eq!(cli::format_memories(&listed), "No local memories found.\n");
    assert_eq!(cli::count(&db).unwrap(), 0);
}

#[test]
fn no_result() {
    let (_d, db) = db();
    cli::remember(&db, "only rust sqlite", "note", "", false, None).unwrap();
    let found = cli::recall(&db, "python chroma", 5, None, None).unwrap();
    assert!(found.is_empty());
    assert_eq!(cli::format_memories(&found), "No local memories found.\n");
}

#[test]
fn no_address_stays_local() {
    let target =
        config::resolve_target_from(None, Some("secret"), PathBuf::from("/tmp/x.db")).unwrap();
    assert!(matches!(target, config::Target::Local { .. }));
    let (_d, db) = db();
    let id = cli::remember(&db, "stays local", "note", "", false, None).unwrap();
    assert!(id > 0);
    assert_eq!(cli::count(&db).unwrap(), 1);
}

#[test]
fn token_reject() {
    let (_d, db) = db();
    let connection = memocap::store::open(&db).unwrap();
    let req = server::Incoming {
        method: "GET".to_owned(),
        path: "/count".to_owned(),
        query: String::new(),
        token: None,
        body: String::new(),
    };
    let response = server::handle(&connection, "secret", &req);
    assert_eq!(response.status, 401);
    assert!(response.body.contains("unauthorized"));
    let denied = server::Incoming {
        method: "POST".to_owned(),
        path: "/remember".to_owned(),
        query: String::new(),
        token: Some("wrong".to_owned()),
        body: r#"{"content":"nope"}"#.to_owned(),
    };
    let response = server::handle(&connection, "secret", &denied);
    assert_eq!(response.status, 401);
    assert_eq!(cli::count(&db).unwrap(), 0);
}

#[test]
fn similar_skips_insert_without_force() {
    let (_d, db) = db();
    let id = cli::remember(&db, "alpha beta", "note", "", false, None).unwrap();
    let err = cli::remember(&db, "alpha beta", "note", "", false, None).unwrap_err();
    let similar = err
        .downcast_ref::<memocap::store::SimilarMemories>()
        .unwrap();
    assert_eq!(similar.candidates[0].id, id);
    assert_eq!(similar.candidates[0].content, "alpha beta");
    assert_eq!(cli::count(&db).unwrap(), 1);
}

#[test]
fn force_inserts_anyway() {
    let (_d, db) = db();
    cli::remember(&db, "alpha beta", "note", "", false, None).unwrap();
    let id = cli::remember(&db, "alpha beta", "note", "", true, None).unwrap();
    assert!(id > 0);
    assert_eq!(cli::count(&db).unwrap(), 2);
}

#[test]
fn recall_default_limit_is_three() {
    let (_d, db) = db();
    for _ in 0..5 {
        cli::remember(&db, "shared token", "note", "", true, None).unwrap();
    }
    let found = cli::recall(
        &db,
        "shared token",
        memocap::store::DEFAULT_RECALL_LIMIT,
        None,
        None,
    )
    .unwrap();
    assert_eq!(found.len(), 3);
}

#[test]
fn recall_kind_filter() {
    let (_d, db) = db();
    cli::remember(&db, "alpha note item", "note", "", false, None).unwrap();
    cli::remember(&db, "alpha pref item", "preference", "", false, None).unwrap();
    let notes = cli::recall(&db, "alpha", 10, Some("note"), None).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].kind, "note");
}

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

    fn run_remote(&self, cwd: &Path, arguments: &[&str]) -> Output {
        let mut command = self.command(cwd, &self.data_dir, arguments);
        command
            .env("MEMOCAP_ADDR", "http://127.0.0.1:1")
            .env("MEMOCAP_TOKEN", "test-token");
        command.output().unwrap()
    }

    fn run_with_data(&self, cwd: &Path, data_dir: &Path, arguments: &[&str]) -> Output {
        let mut command = self.command(cwd, data_dir, arguments);
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

fn add_remote(path: &Path, address: &str) {
    let status = Command::new("git")
        .args(["remote", "add", "origin", address])
        .current_dir(path)
        .env("GIT_MASTER", "1")
        .status()
        .unwrap();
    assert!(status.success());
}

fn has_scope_config(path: &Path) -> bool {
    Command::new("git")
        .args(["config", "--local", "--get", "memocap.scope-id"])
        .current_dir(path)
        .env("GIT_MASTER", "1")
        .status()
        .unwrap()
        .success()
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

fn active_scope(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("active_scope: "))
        .unwrap()
        .to_owned()
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
    assert!(a_recall.contains("source: repository"));

    let cross_scope_forget = fixture.run(&fixture.repo_b, &["forget", &a_id.to_string()]);
    assert_success(&cross_scope_forget);
    assert_eq!(cross_scope_forget.stdout, b"not found #1\n");

    let a_list = fixture.run(&fixture.repo_a, &["list"]);
    assert_success(&a_list);
    assert!(String::from_utf8_lossy(&a_list.stdout).contains("alpha isolation"));
}

#[test]
fn global_memory_flags_bypass_repository_resolution_and_only_operate_on_global_rows() {
    let fixture = CliFixture::new();

    let saved = fixture.run(
        &fixture.repo_a,
        &["remember", "shared global workflow", "--global"],
    );
    assert_success(&saved);
    let global_id = saved_id(&saved);
    assert!(!has_scope_config(&fixture.repo_a));
    assert_success(&fixture.run(&fixture.repo_a, &["remember", "repository-only control"]));

    let local_recall = fixture.run(&fixture.repo_b, &["recall", "global workflow"]);
    assert_success(&local_recall);
    assert!(String::from_utf8_lossy(&local_recall.stdout).contains("source: global"));

    let global_recall = fixture.run(&fixture.repo_b, &["recall", "global workflow", "--global"]);
    assert_success(&global_recall);
    assert!(String::from_utf8_lossy(&global_recall.stdout).contains("shared global workflow"));

    let global_list = fixture.run(&fixture.repo_a, &["list", "--global"]);
    assert_success(&global_list);
    let global_list = String::from_utf8_lossy(&global_list.stdout);
    assert!(global_list.contains("source: global"));
    assert!(!global_list.contains("repository-only control"));

    let forgotten = fixture.run(
        &fixture.repo_b,
        &["forget", &global_id.to_string(), "--global"],
    );
    assert_success(&forgotten);
    assert_eq!(
        forgotten.stdout,
        format!("deleted #{global_id}\n").as_bytes()
    );
}

#[test]
fn topic_shadow_keeps_inventory_visible_and_status_preserves_legacy_global_flag() {
    let fixture = CliFixture::new();

    assert_success(&fixture.run(
        &fixture.repo_a,
        &[
            "remember",
            "global roadmap",
            "--global",
            "--topic",
            " Roadmap\tPlan ",
        ],
    ));
    assert_success(&fixture.run(
        &fixture.repo_a,
        &["remember", "repository roadmap", "--topic", "roadmap plan"],
    ));

    let recall = fixture.run(&fixture.repo_a, &["recall", "roadmap"]);
    assert_success(&recall);
    let recall = String::from_utf8_lossy(&recall.stdout);
    assert!(recall.contains("repository roadmap"));
    assert!(!recall.contains("global roadmap"));

    let list = fixture.run(&fixture.repo_a, &["list"]);
    assert_success(&list);
    let list = String::from_utf8_lossy(&list.stdout);
    assert!(list.contains("repository roadmap"));
    assert!(list.contains("global roadmap"));
    assert!(list.contains("topic: roadmap plan"));

    let status = fixture.run(&fixture.repo_a, &["status"]);
    assert_success(&status);
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(status.contains("active_scope: scope:v1:"));
    assert!(status.contains("repository_count: 1"));
    assert!(status.contains("global_count: 1"));
    assert!(status.contains("visible_count: 2"));
    let agents_path = status
        .lines()
        .find_map(|line| line.strip_prefix("AGENTS.md: "))
        .map(Path::new)
        .unwrap();
    assert!(agents_path.ends_with("AGENTS.md"));
    assert_eq!(
        agents_path.parent().unwrap().canonicalize().unwrap(),
        fixture.repo_a.canonicalize().unwrap()
    );

    let global_status = fixture.run(&fixture.repo_a, &["status", "--global"]);
    assert_success(&global_status);
    assert!(
        String::from_utf8_lossy(&global_status.stdout).contains(&format!(
            "AGENTS.md: {}",
            fixture.home.join(".codex").join("AGENTS.md").display()
        ))
    );
}

#[test]
fn scope_migration_requires_id_or_all_selector() {
    let fixture = CliFixture::new();

    let migration_without_selector = fixture.run(
        &fixture.repo_a,
        &["scope", "migrate", "--from", "global", "--dry-run"],
    );
    assert_eq!(migration_without_selector.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&migration_without_selector.stderr);
    assert!(stderr.contains("<--id <ID>|--all>"), "stderr: {stderr}");
}

#[test]
fn scope_migration_enforces_safety_matrix_and_remote_guard() {
    let fixture = CliFixture::new();
    add_remote(
        &fixture.repo_a,
        "https://user:scope-secret@example.test/acme/memocap.git",
    );

    let first = fixture.run(
        &fixture.repo_a,
        &["remember", "first legacy record", "--global"],
    );
    assert_success(&first);
    let first_id = saved_id(&first);
    assert_success(&fixture.run(
        &fixture.repo_a,
        &["remember", "second legacy record", "--global"],
    ));

    let shown = fixture.run(&fixture.repo_a, &["scope", "show"]);
    assert_success(&shown);
    let shown_text = String::from_utf8_lossy(&shown.stdout);
    assert!(shown_text.contains("active_scope: scope:v1:"));
    assert!(shown_text.contains("source: remote"));
    assert!(!shown_text.contains("scope-secret"));
    assert!(!shown_text.contains("example.test"));
    let current_scope = active_scope(&shown);

    let dry_run = fixture.run(
        &fixture.repo_a,
        &["scope", "migrate", "--from", "global", "--all", "--dry-run"],
    );
    assert_success(&dry_run);
    assert_eq!(dry_run.stdout, b"would migrate 2 memories\n");
    let after_dry_run = fixture.run(&fixture.repo_a, &["list"]);
    assert_success(&after_dry_run);
    assert!(!String::from_utf8_lossy(&after_dry_run.stdout).contains("source: repository"));

    assert_failure(
        &fixture.run(
            &fixture.repo_a,
            &["scope", "migrate", "--from", "global", "--all"],
        ),
        "requires exactly one of --dry-run or --yes",
    );
    assert_failure(
        &fixture.run(
            &fixture.repo_a,
            &[
                "scope",
                "migrate",
                "--from",
                "global",
                "--id",
                &first_id.to_string(),
                "--all",
            ],
        ),
        "cannot be used with",
    );
    assert_failure(
        &fixture.run(
            &fixture.repo_a,
            &[
                "scope",
                "migrate",
                "--from",
                "global",
                "--id",
                &first_id.to_string(),
                "--yes",
            ],
        ),
        "requires --all",
    );
    assert_failure(
        &fixture.run(
            &fixture.repo_a,
            &["scope", "migrate", "--from", "invalid", "--all", "--yes"],
        ),
        "invalid value",
    );

    let one = fixture.run(
        &fixture.repo_a,
        &[
            "scope",
            "migrate",
            "--from",
            "global",
            "--id",
            &first_id.to_string(),
        ],
    );
    assert_success(&one);
    assert_eq!(one.stdout, b"migrated 1 memories\n");
    assert_failure(
        &fixture.run(
            &fixture.repo_a,
            &[
                "scope",
                "migrate",
                "--from",
                &current_scope,
                "--id",
                &first_id.to_string(),
            ],
        ),
        "source and destination scopes must differ",
    );
    let all = fixture.run(
        &fixture.repo_a,
        &["scope", "migrate", "--from", "global", "--all", "--yes"],
    );
    assert_success(&all);
    assert_eq!(all.stdout, b"migrated 1 memories\n");

    assert_failure(
        &fixture.run(&fixture.repo_a, &["scope", "show", "--global"]),
        "unexpected argument '--global'",
    );
    assert_failure(
        &fixture.run_remote(&fixture.repo_b, &["scope", "show"]),
        "scope commands are only available in local mode",
    );
    assert!(!has_scope_config(&fixture.repo_b));
}

#[test]
fn status_surfaces_database_and_remote_count_errors() {
    let fixture = CliFixture::new();
    let invalid_data_dir = fixture.home.join("not-a-directory");
    fs::write(&invalid_data_dir, "not a directory").unwrap();

    assert_failure(
        &fixture.run_with_data(&fixture.repo_a, &invalid_data_dir, &["status"]),
        "创建数据目录失败",
    );
    assert_failure(
        &fixture.run_remote(&fixture.repo_a, &["status"]),
        "http://127.0.0.1:1/count?scope=",
    );
}

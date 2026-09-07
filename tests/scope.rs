use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, MutexGuard},
};

use memocap::scope::{self, ResolutionSource, ScopeId};
use sha2::{Digest, Sha256};

static GIT_ENVIRONMENT: Mutex<()> = Mutex::new(());

struct Repository {
    root: tempfile::TempDir,
    path: PathBuf,
}

struct PathRestore(Option<OsString>);

impl Drop for PathRestore {
    fn drop(&mut self) {
        match self.0.take() {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
    }
}

fn test_directory() -> tempfile::TempDir {
    match tempfile::tempdir() {
        Ok(directory) => directory,
        Err(error) => panic!("temporary directory creation failed: {error}"),
    }
}

fn git_lock() -> MutexGuard<'static, ()> {
    match GIT_ENVIRONMENT.lock() {
        Ok(guard) => guard,
        Err(error) => error.into_inner(),
    }
}

fn git_output(cwd: &Path, arguments: &[&str]) -> Output {
    let _guard = git_lock();
    match Command::new("git")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            cwd.join("memocap-test-global.gitconfig"),
        )
        .output()
    {
        Ok(output) => output,
        Err(_) => panic!("git fixture command could not start"),
    }
}

fn git(cwd: &Path, arguments: &[&str]) -> String {
    let output = git_output(cwd, arguments);
    assert!(output.status.success(), "git fixture command failed");
    match String::from_utf8(output.stdout) {
        Ok(value) => value.trim().to_owned(),
        Err(_) => panic!("git fixture command returned non-UTF-8 output"),
    }
}

fn repository() -> Repository {
    let root = test_directory();
    let path = root.path().join("repository");
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) => panic!("repository fixture creation failed: {error}"),
    }
    git(&path, &["init", "--quiet"]);
    Repository { root, path }
}

fn commit(repository: &Repository) {
    let file = repository.path.join("README.md");
    match fs::write(file, "fixture\n") {
        Ok(()) => {}
        Err(error) => panic!("fixture file write failed: {error}"),
    }
    git(
        &repository.path,
        &["config", "--local", "user.email", "scope@test.invalid"],
    );
    git(
        &repository.path,
        &["config", "--local", "user.name", "Scope Test"],
    );
    git(&repository.path, &["add", "README.md"]);
    git(&repository.path, &["commit", "--quiet", "-m", "fixture"]);
}

fn scope(cwd: &Path) -> anyhow::Result<scope::ResolvedScope> {
    let _guard = git_lock();
    scope::resolve(cwd)
}

fn successful<T>(result: anyhow::Result<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("expected success: {error}"),
    }
}

fn failed<T>(result: anyhow::Result<T>) -> anyhow::Error {
    match result {
        Ok(_) => panic!("expected failure"),
        Err(error) => error,
    }
}

fn expected_scope(kind: &str, identity: &str) -> String {
    let digest = Sha256::digest(
        [
            b"memocap\0scope\0v1\0".as_slice(),
            kind.as_bytes(),
            b"\0",
            identity.as_bytes(),
        ]
        .concat(),
    );
    format!("scope:v1:{digest:x}")
}

fn configured_scope(repository: &Repository) -> String {
    git(
        &repository.path,
        &["config", "--local", "--get", "memocap.scope-id"],
    )
}

#[test]
fn parses_global_and_lowercase_versioned_scope_ids() {
    // Given
    let versioned = format!("scope:v1:{}", "a".repeat(64));

    // When
    let global = successful("global".parse::<ScopeId>().map_err(anyhow::Error::from));
    let parsed = successful(versioned.parse::<ScopeId>().map_err(anyhow::Error::from));

    // Then
    assert!(global.is_global());
    assert_eq!(global.to_string(), "global");
    assert!(!parsed.is_global());
    assert_eq!(parsed.as_str(), versioned);
}

#[test]
fn rejects_noncanonical_scope_ids() {
    // Given
    let uppercase = format!("scope:v1:{}", "A".repeat(64));
    let short = format!("scope:v1:{}", "a".repeat(63));
    let long = format!("scope:v1:{}", "a".repeat(65));

    // When
    let invalid = [
        "",
        " global",
        "GLOBAL",
        "scope:v0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "scope:v1:",
        &uppercase,
        &short,
        &long,
        "scope:v1:gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
    ];

    // Then
    for value in invalid {
        assert!(
            value.parse::<ScopeId>().is_err(),
            "accepted invalid scope ID"
        );
    }
}

#[test]
fn resolves_one_canonical_remote_and_persists_opaque_scope() {
    // Given
    let repository = repository();
    let remote = "https://user:token@GitHub.com/LYY/memocap.git";
    git(&repository.path, &["remote", "add", "origin", remote]);

    // When
    let resolved = successful(scope(&repository.path));

    // Then
    assert_eq!(resolved.source(), ResolutionSource::Remote);
    assert_eq!(
        resolved.scope().as_str(),
        expected_scope("remote", "github.com/LYY/memocap")
    );
    assert_eq!(configured_scope(&repository), resolved.scope().as_str());
    assert!(!resolved.scope().is_global());
    let visible = format!("{resolved:?}");
    assert!(!visible.contains("user:token"));
    assert!(!visible.contains(remote));
}

#[test]
fn reuses_persisted_scope_across_nested_directory_and_branch_change() {
    // Given
    let repository = repository();
    git(
        &repository.path,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/LYY/memocap.git",
        ],
    );
    let initial = successful(scope(&repository.path));
    let nested = repository.path.join("nested").join("directory");
    match fs::create_dir_all(&nested) {
        Ok(()) => {}
        Err(error) => panic!("nested fixture creation failed: {error}"),
    }
    commit(&repository);
    git(
        &repository.path,
        &["switch", "--quiet", "-c", "other-branch"],
    );

    // When
    let nested_scope = successful(scope(&nested));

    // Then
    assert_eq!(nested_scope.source(), ResolutionSource::GitConfig);
    assert_eq!(nested_scope.scope(), initial.scope());
}

#[test]
fn resolves_linked_worktree_to_repository_scope() {
    // Given
    let repository = repository();
    git(
        &repository.path,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/LYY/memocap.git",
        ],
    );
    commit(&repository);
    let primary = successful(scope(&repository.path));
    let linked = repository.root.path().join("linked-worktree");
    let linked_text = linked.to_string_lossy().into_owned();
    git(
        &repository.path,
        &["worktree", "add", "--quiet", "-b", "linked", &linked_text],
    );

    // When
    let linked_scope = successful(scope(&linked));

    // Then
    assert_eq!(linked_scope.source(), ResolutionSource::GitConfig);
    assert_eq!(linked_scope.scope(), primary.scope());
}

#[test]
fn preserves_repository_scope_when_repository_moves() {
    // Given
    let repository = repository();
    git(
        &repository.path,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/LYY/memocap.git",
        ],
    );
    let before_move = successful(scope(&repository.path));
    let moved = repository.root.path().join("moved-repository");
    match fs::rename(&repository.path, &moved) {
        Ok(()) => {}
        Err(error) => panic!("repository fixture move failed: {error}"),
    }

    // When
    let after_move = successful(scope(&moved));

    // Then
    assert_eq!(after_move.source(), ResolutionSource::GitConfig);
    assert_eq!(after_move.scope(), before_move.scope());
}

#[test]
fn canonicalizes_equivalent_https_and_ssh_remotes_without_merging_repositories() {
    // Given
    let https = repository();
    let ssh = repository();
    git(
        &https.path,
        &[
            "remote",
            "add",
            "origin",
            "https://user:token@GitHub.com/LYY/memocap.git",
        ],
    );
    git(
        &ssh.path,
        &["remote", "add", "origin", "git@github.com:LYY/memocap.git"],
    );

    // When
    let https_scope = successful(scope(&https.path));
    let ssh_scope = successful(scope(&ssh.path));

    // Then
    assert_eq!(https_scope.source(), ResolutionSource::Remote);
    assert_eq!(ssh_scope.source(), ResolutionSource::Remote);
    assert_eq!(https_scope.scope(), ssh_scope.scope());
    assert_ne!(https.path, ssh.path);
}

#[test]
fn falls_back_to_git_common_directory_for_ambiguous_or_unsupported_remotes() {
    // Given
    let cases = [
        vec![
            ("origin", "https://github.com/LYY/memocap.git"),
            ("backup", "https://github.com/LYY/backup.git"),
        ],
        vec![("origin", "../local-repository")],
        vec![("origin", "not a remote URL")],
    ];

    // When
    let sources = cases
        .into_iter()
        .map(|remotes| {
            let repository = repository();
            for (name, remote) in remotes {
                git(&repository.path, &["remote", "add", name, remote]);
            }
            successful(scope(&repository.path)).source()
        })
        .collect::<Vec<_>>();

    // Then
    assert_eq!(
        sources,
        vec![
            ResolutionSource::GitCommonDir,
            ResolutionSource::GitCommonDir,
            ResolutionSource::GitCommonDir,
        ]
    );
}

#[test]
fn persists_no_remote_repository_scope_and_reads_it_back() {
    // Given
    let repository = repository();

    // When
    let first = successful(scope(&repository.path));
    let second = successful(scope(&repository.path));

    // Then
    assert_eq!(first.source(), ResolutionSource::GitCommonDir);
    assert_eq!(second.source(), ResolutionSource::GitConfig);
    assert_eq!(first.scope(), second.scope());
    assert_eq!(configured_scope(&repository), first.scope().as_str());
}

#[test]
fn rejects_global_or_malformed_repository_configuration_without_repairing_it() {
    // Given
    let repository = repository();
    let malformed = format!("scope:v1:{}", "A".repeat(64));
    git(
        &repository.path,
        &[
            "remote",
            "add",
            "origin",
            "https://user:token@github.com/LYY/memocap.git",
        ],
    );

    // When
    git(
        &repository.path,
        &["config", "--local", "memocap.scope-id", "global"],
    );
    let global_error = failed(scope(&repository.path));
    assert_eq!(configured_scope(&repository), "global");
    git(
        &repository.path,
        &["config", "--local", "memocap.scope-id", &malformed],
    );
    let malformed_error = failed(scope(&repository.path));

    // Then
    assert_eq!(configured_scope(&repository), malformed);
    for output in [global_error.to_string(), malformed_error.to_string()] {
        assert!(!output.contains("global"));
        assert!(!output.contains("user:token"));
        assert!(!output.contains("github.com/LYY/memocap"));
        assert!(!output.contains(repository.path.to_string_lossy().as_ref()));
    }
}

#[test]
fn uses_directory_scope_when_git_is_unavailable_or_directory_is_not_a_repository() {
    // Given
    let repository = repository();
    let non_git = test_directory();
    let original_path = std::env::var_os("PATH");
    let _guard = git_lock();
    std::env::set_var("PATH", non_git.path());
    let _restore = PathRestore(original_path);

    // When
    let unavailable = successful(scope::resolve(&repository.path));
    let ordinary_directory = successful(scope::resolve(non_git.path()));

    // Then
    assert_eq!(unavailable.source(), ResolutionSource::Directory);
    assert_eq!(ordinary_directory.source(), ResolutionSource::Directory);
    assert_ne!(unavailable.scope(), ordinary_directory.scope());
}

#[test]
fn changes_non_git_directory_scope_when_directory_is_renamed() {
    // Given
    let root = test_directory();
    let original = root.path().join("original");
    let renamed = root.path().join("renamed");
    match fs::create_dir(&original) {
        Ok(()) => {}
        Err(error) => panic!("directory fixture creation failed: {error}"),
    }
    let before = successful(scope(&original));
    match fs::rename(&original, &renamed) {
        Ok(()) => {}
        Err(error) => panic!("directory fixture rename failed: {error}"),
    }

    // When
    let after = successful(scope(&renamed));

    // Then
    assert_eq!(before.source(), ResolutionSource::Directory);
    assert_eq!(after.source(), ResolutionSource::Directory);
    assert_ne!(before.scope(), after.scope());
}

use super::*;

#[test]
fn readonly_derives_remote_identity_without_persisting_or_deleting_legacy_config() {
    let repository = repository();
    git(
        &repository.path,
        &["remote", "add", "origin", "git@github.com:LYY/memocap.git"],
    );
    git(
        &repository.path,
        &[
            "config",
            "--local",
            "memocap.scope-id",
            &format!("scope:v1:{}", "b".repeat(64)),
        ],
    );
    let config_path = repository.path.join(".git/config");
    let before = fs::read(&config_path).unwrap();
    let cwd = std::env::current_dir().unwrap();

    let resolved = {
        let _guard = git_lock();
        scope::resolve_readonly(&repository.path).unwrap()
    };

    assert_eq!(resolved.source(), ResolutionSource::Remote);
    assert_eq!(
        resolved.repository().as_str(),
        expected_repository("remote", "github.com/LYY/memocap")
    );
    assert_eq!(fs::read(config_path).unwrap(), before);
    assert_eq!(std::env::current_dir().unwrap(), cwd);
}

#[test]
fn readonly_configured_identity_wins_without_cleaning_legacy_key() {
    let repository = repository();
    let configured = format!("repository:{}", "c".repeat(64));
    git(
        &repository.path,
        &["config", "--local", "memocap.repository-id", &configured],
    );
    git(
        &repository.path,
        &[
            "config",
            "--local",
            "memocap.scope-id",
            &format!("scope:v1:{}", "b".repeat(64)),
        ],
    );
    let config_path = repository.path.join(".git/config");
    let before = fs::read(&config_path).unwrap();

    let resolved = {
        let _guard = git_lock();
        scope::resolve_readonly(&repository.path).unwrap()
    };

    assert_eq!(resolved.source(), ResolutionSource::GitConfig);
    assert_eq!(resolved.repository().as_str(), configured);
    assert_eq!(fs::read(config_path).unwrap(), before);
}

#[test]
fn readonly_primary_and_linked_worktree_share_common_directory_identity() {
    let repository = repository();
    commit(&repository);
    let linked = repository.root.path().join("linked");
    git(
        &repository.path,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            linked.to_str().unwrap(),
        ],
    );
    let before = fs::read(repository.path.join(".git/config")).unwrap();

    let (primary, worktree) = {
        let _guard = git_lock();
        (
            scope::resolve_readonly(&repository.path).unwrap(),
            scope::resolve_readonly(&linked).unwrap(),
        )
    };

    assert_eq!(primary.source(), ResolutionSource::GitCommonDir);
    assert_eq!(primary.repository(), worktree.repository());
    assert_eq!(
        fs::read(repository.path.join(".git/config")).unwrap(),
        before
    );
}

#[test]
fn readonly_rejects_missing_paths_and_files_but_accepts_canonical_directory_aliases() {
    let directory = test_directory();
    let file = directory.path().join("file");
    fs::write(&file, "fixture").unwrap();

    let _guard = git_lock();
    assert!(scope::resolve_readonly(&file).is_err());
    assert!(scope::resolve_readonly(&directory.path().join("missing")).is_err());
    assert_eq!(
        scope::resolve_readonly(directory.path()).unwrap(),
        scope::resolve_readonly(&directory.path().join(".")).unwrap()
    );
}

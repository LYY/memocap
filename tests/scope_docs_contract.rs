const REBUILD: &str = include_str!("../docs/REBUILD.md");

#[test]
fn rebuild_spec_documents_scope_visibility_shadow_migration_and_remote_boundary() {
    for claim in [
        "默认使用当前仓库 scope",
        "仓库中的 recall 会同时检索当前仓库 scope 和 global scope",
        "仓库 memory 的相同非空 topic 会在 recall 时遮蔽 global memory",
        "不会自动迁移或自动分类",
        "非 Git 目录移动",
        "迁移只在本地进行",
        "地址和 token",
        "不会回退到本地",
    ] {
        assert!(REBUILD.contains(claim), "missing scope contract: {claim}");
    }
    for command in [
        "memocap scope show",
        "memocap remember --global",
        "memocap recall --global",
        "memocap remember --topic",
        "memocap scope migrate --from global --all --dry-run",
        "memocap scope migrate --from global --all --yes",
    ] {
        assert!(REBUILD.contains(command), "missing command: {command}");
    }
}

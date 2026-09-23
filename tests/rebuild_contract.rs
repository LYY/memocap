const REBUILD: &str = include_str!("../docs/REBUILD.md");
const CHANGELOG: &str = include_str!("../CHANGELOG.md");
const GLOBAL_INSTALL: &str = "pnpm add -g @lyy-gh/memocap@0.0.7";
const PLUGIN_INSTALL: &str = "opencode plugin @lyy-gh/memocap";

const V002_CHANGELOG: &str = r#"## 0.0.2 (2026-09-04)

发布恢复候选：保留 `v0.0.1` 的既有 tag、Release 和 npm 包，不重发、不覆盖。

- release workflow 仅接受最终合入 `origin/main` 且携带当前 hardened workflow 的 tag commit，使用同一仓库和 tag 的非取消并发组串行 reconcile，确保 provenance 只来自 tag 触发的成功发布；恢复只能 rerun 同一 current-tag workflow，不能为历史 SHA 打 tag。
- launcher 为冷缓存下载使用每进程唯一临时文件和独占缓存锁，校验 SHA-256 后原子发布并保留可执行权限。

"#;

fn with_lf_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn v007_release_boundary_is_accurate(changelog: &str) -> bool {
    let changelog = with_lf_line_endings(changelog);
    let Some((_, after_heading)) = changelog.split_once("## 0.0.7") else {
        return false;
    };
    let Some((section, _)) = after_heading.split_once("## 0.0.6") else {
        return false;
    };
    let compact = section.lines().map(str::trim).collect::<Vec<_>>().join(" ");

    [
        "Validation and binary-build jobs are read-only.",
        "The sole constrained `release` job holds `contents: write` and creates or uploads verified GitHub Release assets.",
        "The `registry` job uses npm trusted-publisher OIDC to publish the package and verify registry integrity and provenance.",
    ]
    .iter()
    .all(|claim| compact.contains(claim))
        && !compact.contains("release workflow is read-only apart from")
}

const HISTORICAL_CHANGELOG: &str = r#"## 0.1.3 — 2026-09-02

记住前先查重，召回默认少灌一点。

- `remember` 先用 FTS 查同类，撞到就不写；`--force` 才插入，`--id` 覆盖已有行。HTTP `POST /remember` 同样规则，冲突返回 409。
- `recall` 默认 3 条（原先 5），可 `--type` 按 kind 过滤、`--max-chars` 限制总字数；排序在 FTS 之后按新近。
- README 补了忆时记忆系统说明。

## 0.1.2 — 2026-08-25

Docker 镜像升到 rust 1.88；Compose 部署写进 README。Release Action 发三平台二进制和 npm。

## 0.1.1 — 2026-08-25

npm bin 改为 `bin/cli.cjs`，从 GitHub Release 拉二进制。Trusted Publisher 走 Action 发版。

## 0.1.0 — 2026-08-25

第一版。一份 SQLite，四端共用 `remember` / `recall` / `list` / `forget`。不设地址只走本机；设了 ADDR 和 token 走 HTTP / Compose 8787。
"#;

const V001_CHANGELOG: &str = r#"## 0.0.1 (2026-09-02)

独立发布 `@lyy-gh/memocap`，发布源为 [LYY/memocap](https://github.com/LYY/memocap)。OpenCode 是唯一官方支持的集成。

- 通过 Git tag 发布，并保留 tag、源码仓库和构建 artifact 的 release provenance。
- 发布包由 LYY/memocap GitHub Release 提供，OpenCode 插件通过全局 `memocap` CLI 工作。

"#;

#[test]
fn rebuild_spec_has_ordered_scoped_opencode_install() {
    let official_section = current_install_section(REBUILD);
    let commands =
        install_commands(official_section).expect("REBUILD must contain a bash install block");

    assert_eq!(commands, vec![GLOBAL_INSTALL, PLUGIN_INSTALL]);
}

#[test]
fn rebuild_spec_declares_opencode_only_and_legacy_hosts_unsupported() {
    assert!(REBUILD.contains("OpenCode 是唯一官方支持的集成"));
    assert!(REBUILD
        .contains("Codex、Claude Code、Pi 的 host adapter、规则注入和 host path state 已移除"));
}

#[test]
fn rebuild_spec_has_no_stale_host_install_claims() {
    for stale_claim in [
        "四端安装",
        "四个宿主的官方入口",
        "pnpm add -g memocap",
        "npm i -g memocap",
        "pi install npm:memocap",
        "opencode plugin memocap",
        "OpenCode 能 plugin add",
    ] {
        assert!(!REBUILD.contains(stale_claim), "stale claim: {stale_claim}");
    }
}

#[test]
fn changelog_starts_with_v007_release_contract_and_dates_v006_historical() {
    let changelog = with_lf_line_endings(CHANGELOG);
    let top_section = changelog
        .split_once("## 0.0.5")
        .map(|(section, _)| section)
        .expect("CHANGELOG must retain historical releases");

    assert!(top_section.starts_with("# Changelog\n\n## 0.0.7 (2026-09-22)"));
    for claim in [
        "race-safe release authority",
        "successful `CI` push run on `main` for the exact tag SHA",
        "workflow carried by the tag",
        "current `origin/main` tip",
    ] {
        assert!(top_section.contains(claim), "missing v0.0.7 claim: {claim}");
    }
    assert!(top_section.contains("## 0.0.6 (2026-09-22)"));
    for claim in [
        "breaking release",
        "removed, not deprecated",
        "attached domains",
        "immutable first-transfer provenance",
        "authenticated `/v1` routes only",
        "not ACL, IAM",
        "`not_found` alone does not prove manual replay is safe",
        "TUI now exposes only Status, List visible memories, and Exit",
        "exact recognized pre-versioned database",
        "no backup",
    ] {
        assert!(top_section.contains(claim), "missing v0.0.6 claim: {claim}");
    }
    assert!(changelog.contains("## 0.0.5 (2026-09-20)"));
    assert!(changelog.contains("## 0.0.3 (2026-09-07)"));
}

#[test]
fn changelog_v007_distinguishes_release_workflow_write_authorities() {
    assert!(
        v007_release_boundary_is_accurate(CHANGELOG),
        "v0.0.7 changelog must distinguish read-only validation/build, GitHub asset writes, and npm OIDC publication"
    );
}

#[test]
fn changelog_release_boundary_contract_rejects_stale_mutations() {
    for (before, after) in [
        (
            "- Validation and binary-build jobs are read-only.\n- The sole constrained `release` job holds `contents: write` and creates or uploads\n  verified GitHub Release assets.\n- The `registry` job uses npm trusted-publisher OIDC to publish the package and\n  verify registry integrity and provenance.",
            "- The release workflow is read-only apart from the npm trusted-publisher OIDC\n  release contract, which retains registry integrity and provenance checks.",
        ),
        (
            "The sole constrained `release` job holds `contents: write` and creates or uploads\n  verified GitHub Release assets.",
            "The `release` job prepares verified GitHub Release assets.",
        ),
    ] {
        assert_eq!(CHANGELOG.matches(before).count(), 1, "mutation target missing");
        let mutated = CHANGELOG.replacen(before, after, 1);

        assert!(!v007_release_boundary_is_accurate(&mutated));
    }
}

#[test]
fn changelog_preserves_v002_release_entry() {
    let changelog = with_lf_line_endings(CHANGELOG);
    let start = changelog
        .find("## 0.0.2")
        .expect("CHANGELOG must retain the v0.0.2 release");
    let end = changelog[start..]
        .find("## 0.0.1")
        .map(|index| start + index)
        .expect("CHANGELOG must retain the v0.0.1 release");

    assert_eq!(&changelog[start..end], V002_CHANGELOG);
}

#[test]
fn changelog_preserves_historical_content_from_v013_onward() {
    let changelog = with_lf_line_endings(CHANGELOG);
    let historical_start = changelog
        .find("## 0.1.3")
        .expect("CHANGELOG must retain the 0.1.3 release");

    assert_eq!(&changelog[historical_start..], HISTORICAL_CHANGELOG);
}

#[test]
fn changelog_preserves_v001_release_entry() {
    let changelog = with_lf_line_endings(CHANGELOG);
    let start = changelog
        .find("## 0.0.1")
        .expect("CHANGELOG must retain the v0.0.1 release");
    let end = changelog[start..]
        .find("## 0.1.3")
        .map(|index| start + index)
        .expect("CHANGELOG must retain the historical releases");

    assert_eq!(&changelog[start..end], V001_CHANGELOG);
}

#[test]
fn real_rebuild_document_satisfies_strict_contract() {
    assert!(rebuild_contract_is_valid(&with_lf_line_endings(REBUILD)));
}

#[test]
fn rebuild_contract_accepts_windows_line_endings() {
    let windows_rebuild = with_lf_line_endings(REBUILD).replace('\n', "\r\n");

    assert!(rebuild_contract_is_valid(&windows_rebuild));
}

fn current_install_section(rebuild: &str) -> &str {
    rebuild
        .split_once("## 当前安装和边界")
        .and_then(|(_, rest)| rest.split_once("## 当前命令矩阵"))
        .map(|(section, _)| section)
        .expect("REBUILD must contain the current install section")
}

fn install_commands(official_section: &str) -> Option<Vec<&str>> {
    let install_section = official_section;
    let mut in_shell_block = false;
    let mut commands = Vec::new();

    for line in install_section.lines() {
        let line = line.trim();
        if !in_shell_block {
            if line == "```bash" {
                in_shell_block = true;
            }
            continue;
        }
        if line == "```" {
            return Some(commands);
        }
        if !line.is_empty() {
            commands.push(line);
        }
    }

    None
}

fn has_contradictory_legacy_support_claim(rebuild: &str) -> bool {
    let legacy_hosts = ["Codex", "Claude Code", "Pi"];
    let positive_support_terms = ["官方", "支持", "安装", "集成", "入口", "插件"];

    rebuild.lines().any(|line| {
        let mentions_legacy_host = legacy_hosts.iter().any(|host| line.contains(host));
        let is_unsupported_boundary =
            line.contains("仅作历史兼容") && line.contains("不属于官方支持范围");
        mentions_legacy_host
            && !is_unsupported_boundary
            && positive_support_terms
                .iter()
                .any(|term| line.contains(term))
    })
}

fn has_broad_multi_host_support_claim(rebuild: &str) -> bool {
    let broad_host_terms = [
        "四个宿主",
        "四端",
        "各宿主",
        "多宿主",
        "多个宿主",
        "所有宿主",
        "多端",
    ];
    let positive_support_terms = [
        "官方", "支持", "安装", "接到", "读写", "集成", "共用", "可以", "能够", "可用", "工作",
    ];

    rebuild.lines().any(|line| {
        broad_host_terms.iter().any(|term| line.contains(term))
            && positive_support_terms
                .iter()
                .any(|term| line.contains(term))
    })
}

fn rebuild_contract_is_valid(rebuild: &str) -> bool {
    let has_exact_install = install_commands(current_install_section(rebuild))
        .is_some_and(|commands| commands == vec![GLOBAL_INSTALL, PLUGIN_INSTALL]);
    let has_support_boundary = rebuild.contains("OpenCode 是唯一官方支持的集成")
        && rebuild
            .contains("Codex、Claude Code、Pi 的 host adapter、规则注入和 host path state 已移除");
    let has_no_stale_claims = [
        "四端安装",
        "四个宿主的官方入口",
        "pnpm add -g memocap",
        "npm i -g memocap",
        "pi install npm:memocap",
        "opencode plugin memocap",
        "OpenCode 能 plugin add",
    ]
    .iter()
    .all(|claim| !rebuild.contains(claim));

    let matrix = command_matrix(rebuild);
    let has_current_matrix = [
        "memocap scope show",
        "memocap scope domain create <DOMAIN>",
        "memocap scope domain attach <DOMAIN> [--before <DOMAIN>]",
        "memocap scope domain detach <DOMAIN>",
        "memocap scope domain list [--all]",
        "memocap scope domain delete <DOMAIN>",
        "memocap scope copy",
        "memocap scope move",
        "memocap operation status --recovery <RECOVERY>",
    ]
    .iter()
    .all(|command| matrix.contains(command));
    let has_no_removed_matrix_entries = ["memocap install", "memocap uninstall", "--global"]
        .iter()
        .all(|command| !matrix.contains(command));
    let has_current_scope_contract = [
        "repository、按持久化顺序排列的 attached domains、universal",
        "Skill policy、runtime validation、namespace selection、authorization",
        "旧的无版本 HTTP route 已移除",
        "not_found alone 不证明手工 replay 安全",
    ]
    .iter()
    .all(|claim| rebuild.contains(claim));
    has_exact_install
        && has_support_boundary
        && has_no_stale_claims
        && has_current_matrix
        && has_no_removed_matrix_entries
        && has_current_scope_contract
        && !has_contradictory_legacy_support_claim(rebuild)
        && !has_broad_multi_host_support_claim(rebuild)
}

fn command_matrix(rebuild: &str) -> String {
    let normalized_rebuild = with_lf_line_endings(rebuild);
    let section = normalized_rebuild
        .split_once("## 当前命令矩阵")
        .map(|(_, section)| section)
        .expect("REBUILD must contain current command matrix");
    let (_, block) = section
        .split_once("```text\n")
        .expect("REBUILD must contain command matrix block");
    block
        .split_once("\n```")
        .map(|(matrix, _)| matrix.to_owned())
        .expect("REBUILD command matrix must close")
}

#[test]
fn rebuild_contract_rejects_extra_install_command_mutation() {
    let mutated = with_lf_line_endings(REBUILD).replacen(
        "opencode plugin @lyy-gh/memocap\n```",
        "opencode plugin @lyy-gh/memocap\necho unexpected\n```",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_missing_opening_install_fence_mutation() {
    let mutated = with_lf_line_endings(REBUILD).replacen(
        "```bash\npnpm add -g @lyy-gh/memocap@0.0.7",
        "pnpm add -g @lyy-gh/memocap@0.0.7",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_missing_closing_install_fence_mutation() {
    let mutated = with_lf_line_endings(REBUILD).replacen(
        "opencode plugin @lyy-gh/memocap\n```",
        "opencode plugin @lyy-gh/memocap",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_malformed_install_fence_mutation() {
    let mutated = REBUILD.replacen("```bash", "```sh", 1);

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_contradictory_legacy_support_mutation() {
    let mutated = REBUILD.replacen(
        "OpenCode 是唯一官方支持的集成。",
        "OpenCode 是唯一官方支持的集成。Codex 是官方支持的集成。",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_current_four_host_support_mutation() {
    let mutated = REBUILD.replacen(
        "OpenCode 是唯一官方支持的集成。",
        "四个宿主通过官方插件接到同一条 CLI；",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_broad_current_multi_host_mutation() {
    let mutated = REBUILD.replacen(
        "OpenCode 是唯一官方支持的集成。",
        "OpenCode 唯一官方集成。多个宿主均可通过官方入口接入。",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_inverted_stack_precedence() {
    let mutated = REBUILD.replace(
        "repository、按持久化顺序排列的 attached domains、universal",
        "universal、按持久化顺序排列的 attached domains、repository",
    );
    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_unsafe_replay_claim() {
    let mutated = REBUILD.replace(
        "not_found alone 不证明手工 replay 安全",
        "not_found permits manual replay",
    );
    assert!(!rebuild_contract_is_valid(&mutated));
}

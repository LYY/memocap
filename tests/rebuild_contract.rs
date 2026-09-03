const REBUILD: &str = include_str!("../docs/REBUILD.md");
const CHANGELOG: &str = include_str!("../CHANGELOG.md");
const GLOBAL_INSTALL: &str = "pnpm add -g @lyy-gh/memocap@0.0.1";
const PLUGIN_INSTALL: &str = "opencode plugin @lyy-gh/memocap";

fn with_lf_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
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

#[test]
fn rebuild_spec_has_ordered_scoped_opencode_install() {
    let official_section =
        official_support_section(REBUILD).expect("REBUILD must contain the official section");
    let commands =
        install_commands(official_section).expect("REBUILD must contain a bash install block");

    assert_eq!(commands, vec![GLOBAL_INSTALL, PLUGIN_INSTALL]);
}

#[test]
fn rebuild_spec_declares_opencode_only_and_legacy_hosts_unsupported() {
    assert!(REBUILD.contains("OpenCode 是唯一官方支持的集成"));
    assert!(REBUILD.contains("Codex、Claude Code、Pi 仅作历史兼容，不属于官方支持范围"));
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
fn changelog_starts_with_v001_release_contract() {
    let changelog = with_lf_line_endings(CHANGELOG);
    let top_section = changelog
        .split_once("## 0.1.3")
        .map(|(section, _)| section)
        .expect("CHANGELOG must retain historical releases");

    assert!(top_section.starts_with("# Changelog\n\n## 0.0.1 (2026-09-02)"));
    assert!(top_section.contains("@lyy-gh/memocap"));
    assert!(top_section.contains("https://github.com/LYY/memocap"));
    assert!(top_section.contains("OpenCode"));
    assert!(top_section.contains("tag"));
    assert!(top_section.contains("provenance"));
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
fn real_rebuild_document_satisfies_strict_contract() {
    assert!(rebuild_contract_is_valid(&with_lf_line_endings(REBUILD)));
}

fn official_support_section(rebuild: &str) -> Option<&str> {
    rebuild
        .split_once("## 官方 OpenCode 集成")
        .and_then(|(_, rest)| rest.split_once("## 建议的数据模型"))
        .map(|(section, _)| section)
}

fn install_commands(official_section: &str) -> Option<Vec<&str>> {
    let install_section = official_section;
    let install_section = install_section.split_once("### 共享安装")?.1;
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
    let has_exact_install = official_support_section(rebuild)
        .and_then(install_commands)
        .is_some_and(|commands| commands == vec![GLOBAL_INSTALL, PLUGIN_INSTALL]);
    let has_support_boundary = rebuild.contains("OpenCode 是唯一官方支持的集成")
        && rebuild.contains("Codex、Claude Code、Pi 仅作历史兼容，不属于官方支持范围");
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

    has_exact_install
        && has_support_boundary
        && has_no_stale_claims
        && !has_contradictory_legacy_support_claim(rebuild)
        && !has_broad_multi_host_support_claim(rebuild)
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
        "```bash\npnpm add -g @lyy-gh/memocap@0.0.1",
        "pnpm add -g @lyy-gh/memocap@0.0.1",
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
        "OpenCode 通过官方插件接到同一条 CLI；",
        "四个宿主通过官方插件接到同一条 CLI；",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_broad_current_multi_host_mutation() {
    let mutated = REBUILD.replacen(
        "OpenCode 唯一官方集成。",
        "OpenCode 唯一官方集成。多个宿主均可通过官方入口接入。",
        1,
    );

    assert!(!rebuild_contract_is_valid(&mutated));
}

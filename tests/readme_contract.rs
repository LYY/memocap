const ENGLISH: &str = include_str!("../README.md");
const CHINESE: &str = include_str!("../README-CN.md");

fn install_section(readme: &str) -> &str {
    let section = readme
        .split_once("## Install")
        .or_else(|| readme.split_once("## 安装"))
        .map(|(_, section)| section)
        .expect("README must contain an install section");
    section
        .split_once("## ")
        .map_or(section, |(section, _)| section)
}

fn repository_row(readme: &str) -> &str {
    readme
        .lines()
        .find(|line| line.contains("| this repo |") || line.contains("| 本仓库 |"))
        .expect("README must contain this repository comparison row")
}

#[test]
fn both_readmes_use_ordered_scoped_opencode_install() {
    for readme in [ENGLISH, CHINESE] {
        let section = install_section(readme);
        let global_install = "pnpm add -g @lyy-gh/memocap@0.0.1";
        let plugin_install = "opencode plugin @lyy-gh/memocap";

        assert!(section.contains(global_install));
        assert!(section.contains(plugin_install));
        assert!(section.find(global_install) < section.find(plugin_install));
        assert!(!section.contains("pnpm add -g memocap"));
        assert!(!section.contains("memocap install"));
        assert!(!section.contains("pi install"));
    }
}

#[test]
fn both_readmes_explain_opencode_support_and_cli_sidecar_path() {
    assert!(ENGLISH.contains("OpenCode is the only officially supported integration."));
    assert!(ENGLISH.contains("global CLI must be on PATH"));
    assert!(ENGLISH.contains("plugin invokes `memocap` as its sidecar"));

    assert!(CHINESE.contains("OpenCode 是唯一官方支持的集成。"));
    assert!(CHINESE.contains("全局 CLI 必须在 PATH 中"));
    assert!(CHINESE.contains("插件会把 `memocap` 作为 sidecar 调用"));

    assert!(!ENGLISH.contains("Four hosts"));
    assert!(!CHINESE.contains("四个宿主"));
}

#[test]
fn both_readmes_point_server_clone_to_lyy_repository() {
    for readme in [ENGLISH, CHINESE] {
        assert!(readme.contains("git clone https://github.com/LYY/memocap"));
        assert!(!readme.contains("github.com/luodaoyi/memocap"));
    }
}

#[test]
fn repository_rows_name_only_opencode_without_changing_third_party_rows() {
    let english_row = repository_row(ENGLISH);
    let chinese_row = repository_row(CHINESE);

    assert!(english_row.contains("OpenCode"));
    assert!(!english_row.contains("Codex"));
    assert!(!english_row.contains("Claude"));
    assert!(!english_row.contains("Pi"));
    assert!(chinese_row.contains("OpenCode"));
    assert!(!chinese_row.contains("四端官方渠道"));

    for row in [
        "| ClawHub memocap | value-store + recall-first | OpenClaw |",
        "| claude-mem | auto-captures sessions | Claude |",
        "| agentmemory | auto-captures via MCP | multi-host MCP |",
        "| pi-memory | markdown files | Pi |",
    ] {
        assert!(ENGLISH.contains(row));
    }
    for row in [
        "| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |",
        "| claude-mem | 自动抓会话 | Claude |",
        "| agentmemory | 自动抓，多端 MCP | 多端 MCP |",
        "| pi-memory | markdown | 只 Pi |",
    ] {
        assert!(CHINESE.contains(row));
    }
}

#[test]
fn bilingual_install_contract_has_same_machine_consumed_values() {
    for value in [
        "pnpm add -g @lyy-gh/memocap@0.0.1",
        "opencode plugin @lyy-gh/memocap",
        "git clone https://github.com/LYY/memocap",
    ] {
        assert!(ENGLISH.contains(value));
        assert!(CHINESE.contains(value));
    }
}

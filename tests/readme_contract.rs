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

fn install_commands(readme: &str) -> Vec<&str> {
    let mut in_shell_block = false;
    let mut commands = Vec::new();
    for line in install_section(readme).lines() {
        let line = line.trim();
        if line == "```sh" {
            in_shell_block = true;
            continue;
        }
        if in_shell_block && line == "```" {
            in_shell_block = false;
            continue;
        }
        if in_shell_block && !line.is_empty() {
            commands.push(line);
        }
    }
    commands
}

fn install_contract_is_valid(readme: &str) -> bool {
    let section = install_section(readme);
    let global_install = "pnpm add -g @lyy-gh/memocap@0.0.1";
    let plugin_install = "opencode plugin @lyy-gh/memocap";
    let Some(global_position) = section.find(global_install) else {
        return false;
    };
    let Some(plugin_position) = section.find(plugin_install) else {
        return false;
    };

    global_position < plugin_position
        && install_commands(readme) == vec![global_install, plugin_install]
        && !section.contains("pnpm add -g memocap")
        && !section.contains("memocap install")
        && !section.contains("pi install")
}

fn repository_row_is_opencode_only(readme: &str) -> bool {
    let row = repository_row(readme);
    row.contains("OpenCode")
        && !row.contains("Codex")
        && !row.contains("Claude")
        && !row.contains("Pi")
        && !row.contains("四端官方渠道")
}

#[test]
fn both_readmes_use_ordered_scoped_opencode_install() {
    for readme in [ENGLISH, CHINESE] {
        assert!(install_contract_is_valid(readme));
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
    assert!(repository_row_is_opencode_only(ENGLISH));
    assert!(repository_row_is_opencode_only(CHINESE));

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

#[test]
fn inserted_cli_command_is_rejected() {
    let mutated = ENGLISH.replace(
        "opencode plugin @lyy-gh/memocap",
        "memocap --version\nopencode plugin @lyy-gh/memocap",
    );
    assert!(!install_contract_is_valid(&mutated));
}

#[test]
fn injected_legacy_host_in_chinese_repository_row_is_rejected() {
    let mutated = CHINESE.replace(
        "| 本仓库 | 值必存 + 言必检 | 仅 OpenCode，本机 SQLite 或带 token 的服务器 |",
        "| 本仓库 | 值必存 + 言必检 | 仅 OpenCode、Codex，本机 SQLite 或带 token 的服务器 |",
    );

    assert!(!repository_row_is_opencode_only(&mutated));
}

#[test]
fn inserted_unknown_command_between_install_steps_is_rejected() {
    for readme in [ENGLISH, CHINESE] {
        let mutated = readme.replace(
            "pnpm add -g @lyy-gh/memocap@0.0.1\nopencode plugin @lyy-gh/memocap",
            "pnpm add -g @lyy-gh/memocap@0.0.1\necho unexpected\nopencode plugin @lyy-gh/memocap",
        );

        assert!(!install_contract_is_valid(&mutated));
    }
}

#[test]
fn inserted_unknown_command_after_plugin_registration_is_rejected() {
    for readme in [ENGLISH, CHINESE] {
        let mutated = readme.replace(
            "opencode plugin @lyy-gh/memocap",
            "opencode plugin @lyy-gh/memocap\necho unexpected",
        );

        assert!(!install_contract_is_valid(&mutated));
    }
}

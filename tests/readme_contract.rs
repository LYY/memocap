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
    let global_install = "pnpm add -g @lyy-gh/memocap@0.0.9";
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
        "pnpm add -g @lyy-gh/memocap@0.0.9",
        "opencode plugin @lyy-gh/memocap",
        "git clone https://github.com/LYY/memocap",
    ] {
        assert!(ENGLISH.contains(value));
        assert!(CHINESE.contains(value));
    }
}

#[test]
fn both_readmes_document_the_current_scope_command_surface() {
    for readme in [ENGLISH, CHINESE] {
        for command in [
            "memocap remember",
            "--type <TYPE>",
            "--tags <TAGS>",
            "--force",
            "--id <ID>",
            "--domain <DOMAIN>",
            "--universal",
            "--topic <TOPIC>",
            "memocap recall",
            "--limit <LIMIT>",
            "--max-chars <MAX_CHARS>",
            "memocap list",
            "memocap forget",
            "memocap scope show",
            "memocap scope domain create",
            "memocap scope domain attach",
            "memocap scope domain detach",
            "memocap scope domain list",
            "memocap scope domain delete",
            "memocap scope copy",
            "memocap scope move",
            "--from <PLACEMENT>",
            "--to <PLACEMENT>",
            "--yes",
            "memocap operation status",
            "--recovery <RECOVERY>",
            "memocap status",
            "memocap serve",
            "--bind <BIND>",
            "memocap ui",
        ] {
            assert!(readme.contains(command), "missing {command}");
        }
    }
}

#[test]
fn both_readmes_document_scope_visibility_and_topic_shadow() {
    assert!(ENGLISH.contains("repository scope"));
    assert!(ENGLISH.contains("universal memory"));
    assert!(ENGLISH.contains("default visible stack is ordered as follows"));
    assert!(ENGLISH.contains("same non-empty normalized topic shadows matching"));
    assert!(ENGLISH.contains("canonical non-Git directory path"));

    assert!(CHINESE.contains("仓库 scope"));
    assert!(CHINESE.contains("universal memory"));
    assert!(CHINESE.contains("默认 visible stack 顺序是"));
    assert!(CHINESE.contains("相同的非空 normalized topic 会遮蔽"));
    assert!(CHINESE.contains("非 Git 目录"));
}

#[test]
fn both_readmes_document_strict_remote_selection_and_scope_transport() {
    assert!(ENGLISH.contains("MEMOCAP_ADDR"));
    assert!(ENGLISH.contains("MEMOCAP_TOKEN"));
    assert!(ENGLISH.contains("address and token"));
    assert!(ENGLISH.contains("scope"));
    assert!(ENGLISH.contains("does not fall back to local"));
    assert!(ENGLISH.contains("Remote requests carry a valid remote scope ID"));

    assert!(CHINESE.contains("MEMOCAP_ADDR"));
    assert!(CHINESE.contains("MEMOCAP_TOKEN"));
    assert!(CHINESE.contains("地址和 token"));
    assert!(CHINESE.contains("scope"));
    assert!(CHINESE.contains("不会回退到本地"));
    assert!(CHINESE.contains("远程请求携带有效 remote scope ID"));
}

#[test]
fn both_readmes_distinguish_authentication_from_transport_protection() {
    assert!(ENGLISH.contains(
        "Bearer authentication does not provide transport confidentiality or integrity."
    ));
    assert!(CHINESE.contains("Bearer 鉴权不提供传输保密性或完整性。"));
}

#[test]
fn both_readmes_document_remote_scope_as_strictly_validated() {
    assert!(ENGLISH.contains("remote scope ID"));
    assert!(ENGLISH.contains("valid remote scope ID"));
    assert!(CHINESE.contains("远程 scope ID"));
    assert!(CHINESE.contains("有效 scope"));
}

#[test]
fn both_readmes_document_non_git_scope_identity() {
    assert!(ENGLISH.contains("canonical non-Git directory path"));
    assert!(CHINESE.contains("规范化的非 Git 目录路径"));
}

#[test]
fn bilingual_scope_command_blocks_are_behaviorally_aligned() {
    assert_eq!(command_matrix(ENGLISH), command_matrix(CHINESE));
    for command in [
        "memocap scope show",
        "memocap scope domain create <DOMAIN>",
        "memocap scope domain attach <DOMAIN> [--before <DOMAIN>]",
        "memocap scope domain detach <DOMAIN>",
        "memocap scope domain list [--all]",
        "memocap scope domain delete <DOMAIN>",
        "memocap scope copy --id <ID> --from <PLACEMENT> --to <PLACEMENT>",
        "memocap scope move --id <ID> --from <PLACEMENT> --to <PLACEMENT> --yes",
        "memocap operation status --recovery <RECOVERY>",
    ] {
        assert!(
            command_matrix(ENGLISH).contains(command),
            "matrix missing {command}"
        );
    }
}

#[test]
fn command_matrix_accepts_windows_line_endings() {
    let windows_readme = ENGLISH.replace("\r\n", "\n").replace('\n', "\r\n");

    assert_eq!(command_matrix(&windows_readme), command_matrix(ENGLISH));
}

fn command_matrix(readme: &str) -> String {
    let readme = readme.replace("\r\n", "\n");
    let heading = if readme.contains("## Command matrix") {
        "## Command matrix"
    } else {
        "## 命令矩阵"
    };
    let section = readme
        .split_once(heading)
        .map(|(_, section)| section)
        .expect("README must contain command matrix heading");
    let (_, block) = section
        .split_once("```text\n")
        .expect("README must contain command matrix block");
    block
        .split_once("\n```")
        .map(|(matrix, _)| matrix.to_owned())
        .expect("README command matrix must close")
}

fn current_docs_contract_is_valid(readme: &str) -> bool {
    let required = [
        "memocap scope domain create",
        "memocap scope copy",
        "memocap scope move",
        "memocap operation status --recovery",
        "repository, then attached domains in persisted order, then universal",
        "not ACL, IAM, per-user authorization, or tenant isolation",
        "does not auto-classify content",
        "guarantee compliance",
        "not prove manual replay is safe",
        "removed, not deprecated",
        "Legacy unversioned HTTP routes are removed",
        "Runtime validation is separate",
        "Namespace selection is separate again",
        "Authorization is only",
    ];
    let forbidden = [
        "POST /remember",
        "POST /recall",
        "POST /list",
        "POST /forget",
        "POST /status",
        "universal, then attached domains",
        "is ACL/IAM",
        "auto-classifies content",
        "not_found permits manual replay",
    ];
    required.iter().all(|claim| readme.contains(claim))
        && forbidden.iter().all(|claim| !readme.contains(claim))
        && !command_matrix(readme).contains("memocap install")
        && !command_matrix(readme).contains("memocap uninstall")
        && !command_matrix(readme).contains("--global")
}

#[test]
fn both_readmes_keep_current_domain_remote_and_recovery_contract() {
    assert!(current_docs_contract_is_valid(ENGLISH));
    assert!(CHINESE.contains("已移除的 surface 是 removed，不是 deprecated"));
    assert!(CHINESE.contains("不会自动分类"));
    assert!(CHINESE.contains("不是 ACL、IAM、按用户授权或 tenant isolation"));
    assert!(CHINESE.contains("not_found alone 不证明手工 replay 安全"));
}

#[test]
fn readme_contract_rejects_inverted_stack_precedence() {
    let mutated = ENGLISH.replace(
        "repository, then attached domains in persisted order, then universal",
        "universal, then attached domains in persisted order, then repository",
    );
    assert!(!current_docs_contract_is_valid(&mutated));
}

#[test]
fn readme_contract_rejects_auto_classification_claim() {
    let mutated = ENGLISH.replace("does not auto-classify", "auto-classifies");
    assert!(!current_docs_contract_is_valid(&mutated));
}

#[test]
fn readme_contract_rejects_acl_claim() {
    let mutated = ENGLISH.replace(
        "not ACL, IAM, per-user authorization, or tenant isolation",
        "is ACL/IAM authorization with tenant isolation",
    );
    assert!(!current_docs_contract_is_valid(&mutated));
}

#[test]
fn readme_contract_rejects_unsafe_replay_claim() {
    let mutated = ENGLISH.replace(
        "not prove manual replay is safe",
        "proves manual replay is safe",
    );
    assert!(!current_docs_contract_is_valid(&mutated));
}

#[test]
fn readme_contract_rejects_restored_legacy_route_claim() {
    let mutated = ENGLISH.replace(
        "Legacy unversioned HTTP routes are removed.",
        "Legacy unversioned HTTP routes remain available.",
    );
    assert!(!current_docs_contract_is_valid(&mutated));
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
    let english_crlf = ENGLISH.replace("\r\n", "\n").replace('\n', "\r\n");
    let chinese_crlf = CHINESE.replace("\r\n", "\n").replace('\n', "\r\n");
    for readme in [ENGLISH, CHINESE, &english_crlf, &chinese_crlf] {
        let newline = if readme.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mutated = readme.replace(
            &format!("pnpm add -g @lyy-gh/memocap@0.0.9{newline}opencode plugin @lyy-gh/memocap"),
            &format!("pnpm add -g @lyy-gh/memocap@0.0.9{newline}echo unexpected{newline}opencode plugin @lyy-gh/memocap"),
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

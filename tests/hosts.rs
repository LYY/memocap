use memocap::hosts;

#[test]
fn official_hosts_only_include_scoped_opencode_plugin() {
    assert_eq!(
        hosts::official_hosts().as_slice(),
        &[hosts::OPENCODE_INSTALL]
    );
    assert_eq!(hosts::OPENCODE_INSTALL, "opencode plugin @lyy-gh/memocap");
}

#[test]
fn official_hosts_keep_legacy_integrations_callable_but_unsupported() {
    assert_eq!(hosts::CODEX_INSTALL, "memocap install");
    assert_eq!(hosts::CLAUDE_INSTALL, "memocap install");
    assert_eq!(hosts::PI_INSTALL, "pi install npm:@lyy-gh/memocap");

    let skill = hosts::skill_markdown("memocap");
    assert!(skill.contains("memocap recall"));
}

#[test]
fn official_hosts_cli_help_is_opencode_only() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_memocap"))
        .arg("--help")
        .output()
        .expect("memocap --help should run");
    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("help output should be UTF-8");
    assert!(stdout.contains("Local-first SQLite memory for OpenCode"));
    assert!(!stdout.contains("four hosts"));
}

#[test]
fn plugin_uses_official_default_export() {
    let plugin = include_str!("../plugin/index.js");
    assert!(plugin.contains("server: memocap"));
    assert!(plugin.contains("id: \"memocap\""));
    assert!(!plugin.contains("export default async function"));
    assert!(!plugin.contains("export { run, RULES }"));
    assert!(!plugin.contains("better-sqlite"));
    assert!(!plugin.to_lowercase().contains("chroma"));
}

#[test]
fn plugin_sidecar_uses_cli_not_a_second_store() {
    let sidecar = include_str!("../plugin/cli.js");
    assert!(sidecar.contains("spawnSync"));
    assert!(sidecar.contains("memocap"));
    assert!(!sidecar.contains("better-sqlite"));
}

#[test]
fn skill_uses_cli_not_a_second_store() {
    let skill = include_str!("../skills/memocap/SKILL.md");
    assert!(skill.contains("memocap remember"));
    assert!(skill.contains("Do not open another store") || skill.contains("do not open another"));
    assert!(skill.contains("言必检"));
    assert!(skill.contains("值必存"));
}

#[test]
fn package_keeps_legacy_skill_files() {
    let pkg = include_str!("../package.json");
    assert!(pkg.contains("\"skills\""));

    let skill = include_str!("../skills/memocap/SKILL.md");
    assert!(skill.contains("memocap remember"));
}

#[test]
fn package_json_has_bin_launcher() {
    let pkg = include_str!("../package.json");
    assert!(pkg.contains("\"memocap\": \"bin/cli.cjs\""));
}

#[test]
fn bin_launcher_downloads_release_assets() {
    let launcher = include_str!("../bin/cli.cjs");
    assert!(launcher.contains("memocap-x86_64-unknown-linux-gnu"));
    assert!(launcher.contains("memocap-aarch64-apple-darwin"));
    assert!(launcher.contains("memocap-x86_64-pc-windows-msvc.exe"));
    assert!(launcher.contains("spawnSync"));
    assert!(!launcher.contains("better-sqlite"));
    assert!(!launcher.to_lowercase().contains("chroma"));
}

#[test]
fn dockerfile_rust_compiles_edition2024() {
    let docker = include_str!("../Dockerfile");
    assert!(docker.contains("FROM rust:1.88-bookworm AS build"));
    assert!(!docker.contains("rust:1.85"));
}

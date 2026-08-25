use memocap::hosts;

#[test]
fn four_hosts_exist() {
    let hosts = hosts::official_hosts();
    assert_eq!(hosts.len(), 4);
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
fn pi_skills_point_at_skill_md_dir() {
    let pkg = include_str!("../package.json");
    assert!(pkg.contains("./skills/memocap"));
}

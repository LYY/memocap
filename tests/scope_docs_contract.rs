const REBUILD: &str = include_str!("../docs/REBUILD.md");
const DEPLOYMENT: &str = include_str!("../docs/DEPLOYMENT.md");
const COMPOSE: &str = include_str!("../compose.yaml");

fn scope_contract_is_valid(document: &str) -> bool {
    let required = [
        "默认 stack 顺序是 repository、按持久化顺序排列的 attached domains、universal",
        "Repository 相同的非空 normalized topic 会遮蔽所有更低层匹配项",
        "Domain 相同的 topic 会遮蔽 universal",
        "Domain 之间互不遮蔽",
        "memocap scope show",
        "memocap scope domain create <DOMAIN>",
        "memocap scope domain attach <DOMAIN> [--before <DOMAIN>]",
        "memocap scope domain detach <DOMAIN>",
        "memocap scope domain list [--all]",
        "memocap scope domain delete <DOMAIN>",
        "memocap scope copy",
        "memocap scope move",
        "provenance 不可变",
        "operation ledger",
        "not_found alone 不证明手工 replay 安全",
        "不会自动分类",
        "不会自动创建或挂载 domain",
        "不是 ACL、IAM、用户授权或 tenant",
        "旧的无版本 HTTP route 已移除",
    ];
    let forbidden = [
        "global scope",
        "global memory",
        "`--global` 已移除",
        "universal, then attached domains",
        "universal、按持久化顺序排列的 attached domains、repository",
        "自动分类并选择 placement",
        "not_found permits manual replay",
    ];
    required.iter().all(|claim| document.contains(claim))
        && forbidden.iter().all(|claim| !document.contains(claim))
}

fn deployment_contract_is_valid(document: &str) -> bool {
    let required = [
        "Authorization: Bearer <MEMOCAP_TOKEN>",
        "not ACL, IAM, per-user authorization, or tenant isolation",
        "does not auto-classify",
        "/v1/memories/remember",
        "/v1/domains/attach",
        "/v1/memories/copy",
        "/v1/operations/status",
        "not_found alone does not prove manual replay is safe",
        "operation status request can itself become unknown",
        "There is no route fallback and no remote-to-local fallback",
        "Write, delete, and legacy host actions are removed from the TUI, not deprecated",
        "Bearer authentication does not provide transport confidentiality or integrity.",
        "127.0.0.1:8787:8787",
        "TLS-terminating reverse proxy",
        "not an implementation of TLS, ACL, IAM",
    ];
    let forbidden = [
        "is ACL/IAM authorization with tenant isolation",
        "not_found proves manual replay is safe",
        "automatic classification guarantees compliance",
        "Bearer authentication alone protects transport",
    ];
    required.iter().all(|claim| document.contains(claim))
        && forbidden.iter().all(|claim| !document.contains(claim))
}

fn compose_contract_is_valid(compose: &str) -> bool {
    let compose = compose.replace("\r\n", "\n");

    compose
        .split_once("    ports:\n")
        .and_then(|(_, remainder)| remainder.split_once("\n    environment:"))
        .is_some_and(|(ports, _)| ports.trim() == "- \"127.0.0.1:8787:8787\"")
}

#[test]
fn rebuild_spec_documents_current_scope_visibility_and_remote_boundary() {
    assert!(scope_contract_is_valid(REBUILD));
    for claim in [
        "MEMOCAP_ADDR",
        "MEMOCAP_TOKEN",
        "不会回退到本地",
        "repository、按持久化顺序排列的 attached domains、universal",
        "旧的无版本 HTTP route 已移除",
        "Skill policy、runtime validation、namespace selection、authorization",
    ] {
        assert!(REBUILD.contains(claim), "missing scope contract: {claim}");
    }
}

#[test]
fn deployment_documents_operator_surface_and_trust_boundary() {
    for claim in [
        "MEMOCAP_TOKEN",
        "Authorization: Bearer <MEMOCAP_TOKEN>",
        "not ACL, IAM, per-user authorization, or tenant isolation",
        "does not auto-classify",
        "Runtime validation",
        "Namespace selection",
        "Authorization",
        "/v1/memories/remember",
        "/v1/domains/attach",
        "/v1/memories/copy",
        "/v1/operations/status",
        "not_found alone does not prove manual replay is safe",
        "operation status request can itself become unknown",
        "There is no route fallback and no remote-to-local fallback",
        "Write, delete, and legacy host actions are removed from the TUI, not deprecated",
    ] {
        assert!(
            DEPLOYMENT.contains(claim),
            "missing deployment contract: {claim}"
        );
    }
    assert!(deployment_contract_is_valid(DEPLOYMENT));
}

#[test]
fn compose_defaults_to_loopback_only_plaintext_access() {
    assert!(compose_contract_is_valid(COMPOSE));
}

#[test]
fn compose_contract_accepts_windows_line_endings() {
    let lf_compose = COMPOSE.replace("\r\n", "\n");
    let windows_compose = lf_compose.replace('\n', "\r\n");

    assert!(compose_contract_is_valid(&lf_compose));
    assert!(compose_contract_is_valid(&windows_compose));
}

#[test]
fn compose_contract_rejects_all_interface_plaintext_publish() {
    let lf_compose = COMPOSE.replace("\r\n", "\n");
    let windows_compose = lf_compose.replace('\n', "\r\n");

    for compose in [&lf_compose, &windows_compose] {
        for all_interface_publish in ["8787:8787", "0.0.0.0:8787:8787"] {
            let mutated = compose.replace("127.0.0.1:8787:8787", all_interface_publish);
            assert!(!compose_contract_is_valid(&mutated));
        }
    }
}

#[test]
fn rebuild_contract_rejects_inverted_stack_precedence() {
    let mutated = REBUILD.replace(
        "repository、按持久化顺序排列的 attached domains、universal",
        "universal、按持久化顺序排列的 attached domains、repository",
    );
    assert!(!scope_contract_is_valid(&mutated));
}

#[test]
fn rebuild_contract_rejects_auto_classification_claim() {
    let mutated = REBUILD.replace("不会自动分类", "会自动分类");
    assert!(!scope_contract_is_valid(&mutated));
}

#[test]
fn deployment_contract_rejects_acl_claim() {
    let mutated = DEPLOYMENT.replace(
        "not ACL, IAM, per-user authorization, or tenant isolation",
        "is ACL/IAM authorization with tenant isolation",
    );
    assert!(!deployment_contract_is_valid(&mutated));
}

#[test]
fn deployment_contract_rejects_unsafe_replay_claim() {
    let mutated = DEPLOYMENT.replace(
        "not_found alone does not prove manual replay is safe",
        "not_found proves manual replay is safe",
    );
    assert!(!deployment_contract_is_valid(&mutated));
}

#[test]
fn deployment_contract_rejects_bearer_as_transport_protection() {
    let lf_deployment = DEPLOYMENT.replace("\r\n", "\n");
    let windows_deployment = lf_deployment.replace('\n', "\r\n");

    for deployment in [&lf_deployment, &windows_deployment] {
        let mutated = deployment.replace(
            "Bearer authentication does not provide transport confidentiality or integrity.",
            "Bearer authentication alone protects transport confidentiality and integrity.",
        );
        assert!(!deployment_contract_is_valid(&mutated));
    }
}

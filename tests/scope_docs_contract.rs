const COMPOSE: &str = include_str!("../compose.yaml");

fn compose_contract_is_valid(compose: &str) -> bool {
    let compose = compose.replace("\r\n", "\n");

    compose
        .split_once("    ports:\n")
        .and_then(|(_, remainder)| remainder.split_once("\n    environment:"))
        .is_some_and(|(ports, _)| ports.trim() == "- \"127.0.0.1:8787:8787\"")
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

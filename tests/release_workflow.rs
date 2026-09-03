#[path = "support/release_workflow.rs"]
mod release_workflow_contract;

use release_workflow_contract::{normalized_workflow, release_contract, RELEASE_WORKFLOW};

#[test]
fn actual_release_workflow_enforces_release_and_registry_contract() {
    assert_eq!(release_contract(RELEASE_WORKFLOW), Ok(()));
}

#[test]
fn release_contract_accepts_windows_crlf_checkout() {
    let windows_checkout = normalized_workflow(RELEASE_WORKFLOW).replace('\n', "\r\n");

    assert_eq!(release_contract(&windows_checkout), Ok(()));
}

#[test]
fn release_build_pins_cargo_minimum_toolchain() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);

    assert!(workflow.contains("toolchain: 1.88.0"));
}

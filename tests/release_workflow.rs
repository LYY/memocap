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

#[test]
fn release_workflow_publishes_launcher_assets_after_validated_builds() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);

    for required in [
        "  release:\n",
        "needs: [validate, binaries]",
        "contents: write",
        "gh release create \"$TAG\"",
        "gh release upload \"$TAG\"",
        "memocap-x86_64-unknown-linux-gnu",
        "memocap-aarch64-apple-darwin",
        "memocap-x86_64-pc-windows-msvc.exe",
    ] {
        assert!(workflow.contains(required), "missing {required}");
    }
    assert!(!workflow.contains("workflow_dispatch"));
}

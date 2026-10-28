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
fn release_contract_accepts_verified_action_refs_in_both_step_forms() {
    for reference in [
        "actions/checkout@v7",
        "actions/setup-node@v7",
        "actions/upload-artifact@v7",
        "actions/download-artifact@v8",
        "dtolnay/rust-toolchain@stable",
    ] {
        for step in [
            format!("      - uses: {reference}\n"),
            format!("      - name: Additional action\n        uses: {reference}\n"),
        ] {
            let workflow = format!("{}{step}", normalized_workflow(RELEASE_WORKFLOW));

            assert_eq!(release_contract(&workflow), Ok(()), "{step}");
        }
    }
}

#[test]
fn release_contract_rejects_sha_unversioned_and_development_action_refs() {
    for reference in [
        "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
        "actions/checkout",
        "actions/checkout@main",
        "actions/checkout@master",
        "actions/checkout@v7.0.0-rc.1",
        "dtolnay/rust-toolchain@nightly",
    ] {
        for step in [
            format!("      - uses: {reference}\n"),
            format!("      - name: Additional action\n        uses: {reference}\n"),
        ] {
            let workflow = format!("{}{step}", normalized_workflow(RELEASE_WORKFLOW));

            assert_eq!(
                release_contract(&workflow),
                Err(format!(
                    "action must use a verified stable ref: {reference}"
                )),
                "{step}"
            );
        }
    }
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

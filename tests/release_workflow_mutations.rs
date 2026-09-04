#[path = "support/release_workflow.rs"]
mod release_workflow_contract;

use release_workflow_contract::{normalized_workflow, release_contract, RELEASE_WORKFLOW};

fn mutate(workflow: &str, before: &str, after: &str) -> String {
    assert_eq!(
        workflow.matches(before).count(),
        1,
        "mutation target must be unique"
    );
    workflow.replacen(before, after, 1)
}

fn mutate_registry(workflow: &str, before: &str, after: &str) -> String {
    let index = workflow
        .find("  registry:\n")
        .expect("missing registry job");
    let (prefix, registry) = workflow.split_at(index);
    format!("{prefix}{}", mutate(registry, before, after))
}

#[test]
fn release_contract_rejects_release_write_before_initial_read() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    let mutated = mutate(
        &workflow,
        "release=\"$(read_release)\"\n          if",
        "gh release edit \"$TAG\" --draft\n          release=\"$(read_release)\"\n          if",
    );

    assert!(release_contract(&mutated).is_err());
}

#[test]
fn release_contract_requires_draft_readback_retry() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    assert_eq!(release_contract(&workflow), Ok(()));
    let mutated = mutate(
        &workflow,
        "release=\"$(wait_for_release)\"",
        "release=\"$(read_release)\"",
    );

    assert!(release_contract(&mutated).is_err());
}

#[test]
fn release_contract_rejects_critical_workflow_mutations() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    assert_eq!(release_contract(&workflow), Ok(()));
    for (before, after) in [
        (
            "git merge-base --is-ancestor \"$sha\" origin/main",
            ": # skipped ancestry validation",
        ),
        (
            "group: release-${{ github.repository }}-${{ github.ref_name }}",
            "group: release-${{ github.repository }}",
        ),
        ("cancel-in-progress: false", "cancel-in-progress: true"),
        (
            "Set-Content -NoNewline -Encoding ascii",
            "Out-File -Encoding ascii",
        ),
        (
            "verify_existing_assets \"$release\"",
            ": # skipped asset verification",
        ),
        (
            "verify_existing_assets \"$release\"",
            "gh release edit \"$TAG\" --draft\n        verify_existing_assets \"$release\"",
        ),
        (
            "1:0) verify_existing_binary \"$asset\" ;;",
            "1:0) : # skipped binary verification ;;;",
        ),
        (
            "0:1) verify_existing_checksum \"$asset\" ;;",
            "0:1) : # skipped checksum verification ;;;",
        ),
        (
            "release=\"$(wait_for_uploaded_assets \"$release\" \"${missing[@]}\")\"",
            "release=\"$(read_release)\"",
        ),
        (".[0].draft | type", ".[0].draft"),
        ("GITHUB_WORKFLOW_SHA", "GITHUB_SHA"),
        ("GITHUB_WORKFLOW_REF", "GITHUB_REF"),
        (
            "release_recovery_sha=\"86b4c20a79db2d4cac3eeaeebf19143778e572d2\"",
            "release_recovery_sha=\"0000000000000000000000000000000000000000\"",
        ),
        ("[ \"$workflow_identity\" = \"$tag_workflow\" ]", "true"),
        (
            "[ \"$GITHUB_WORKFLOW_REF\" = \"$expected_workflow_ref\" ]",
            "true",
        ),
        ("[ \"$tag_workflow\" = \"$main_workflow\" ]", "true"),
    ] {
        let mutated = mutate(&workflow, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
    for (before, after) in [
        ("[.assets[].name] | sort | join", "[.assets[].name] | join"),
        (
            "sha256sum \"$directory/$asset\"",
            "true # skipped digest verification",
        ),
        ("id-token: write", "id-token: none"),
        (
            "npm install --ignore-scripts --package-lock=false",
            "npm install --ignore-scripts --no-save --package-lock=false",
        ),
        (
            ".bundle.dsseEnvelope.payload",
            ".bundle.dsseEnvelope.encodedPayload",
        ),
        (
            "$provenance_workflow.repository == $repository",
            "true",
        ),
        (
            "startswith($run + \"/attempts/\")",
            "true",
        ),
        (
            "expected_run=\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"",
            "expected_run=\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT\"",
        ),
        ("test(\"^[0-9]+$\")", "test(\".+\")"),
        (
            "if [ \"$GITHUB_RUN_ATTEMPT\" -eq 1 ]; then",
            "if true; then",
        ),
        (
            "error_file=\"$RUNNER_TEMP/npm-view-error\"",
            "npm publish --access public --provenance\n          error_file=\"$RUNNER_TEMP/npm-view-error\"",
        ),
        (
            "if npm publish --access public --provenance; then",
            "env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}\n          if npm publish --access public --provenance; then",
        ),
        ("[ \"$actual_assets\" = \"$expected_names\" ]", "true # skipped exact asset equality"),
        ("for attempt in {1..10}; do", "for attempt in {1..1}; do"),
        (
            "for verification_attempt in {1..10}; do",
            "for verification_attempt in {1..1}; do",
        ),
        ("if registry_matches; then", "if false; then"),
        (
            "if npm publish --access public --provenance; then",
            "npm publish --access public --provenance",
        ),
    ] {
        let mutated = mutate_registry(&workflow, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
}

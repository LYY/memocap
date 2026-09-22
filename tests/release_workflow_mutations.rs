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
fn release_contract_rejects_tag_authority_and_identity_mutations() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    assert_eq!(release_contract(&workflow), Ok(()));

    for (before, after) in [
        ("git merge-base --is-ancestor \"$sha\" origin/main", "true"),
        (
            "group: release-${{ github.repository }}-${{ github.ref_name }}",
            "group: release-${{ github.repository }}",
        ),
        ("cancel-in-progress: false", "cancel-in-progress: true"),
        ("gh run list", "gh run view"),
        ("--workflow CI", "--workflow Release"),
        ("--event push", "--event pull_request"),
        ("--branch main", "--branch release"),
        ("--commit \"$sha\"", "--commit \"$GITHUB_SHA\""),
        (".conclusion == \"success\"", ".conclusion == \"failure\""),
        (
            "permissions:\n  contents: read\n  actions: read",
            "permissions:\n  contents: read\n  actions: write",
        ),
        ("GITHUB_WORKFLOW_SHA", "GITHUB_SHA"),
        ("GITHUB_WORKFLOW_REF", "GITHUB_REF"),
        ("[ \"$workflow_identity\" = \"$tag_workflow\" ]", "true"),
        (
            "[ \"$GITHUB_WORKFLOW_REF\" = \"$expected_workflow_ref\" ]",
            "true",
        ),
        ("on:\n", "on:\n  workflow_dispatch:\n"),
        (
            "  registry:\n",
            "  release:\n    permissions:\n      contents: write\n\n  registry:\n",
        ),
        (
            "  registry:\n",
            "  registry:\n    permissions:\n      contents: write\n",
        ),
        (
            "environment: npm-release",
            "environment: npm-release # gh release create \"$TAG\"",
        ),
    ] {
        let mutated = mutate(&workflow, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
}

#[test]
fn release_contract_retains_registry_oidc_publish_guards() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    assert_eq!(release_contract(&workflow), Ok(()));

    for (before, after) in [
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
        ("test(\"^[1-9][0-9]*$\")", "test(\"^[0-9]+$\")"),
        ("test(\"^[1-9][0-9]*$\")", "test(\"^0$\")"),
        ("test(\"^[1-9][0-9]*$\")", "test(\"^0[0-9]+$\")"),
        (
            "if [ \"$GITHUB_RUN_ATTEMPT\" -eq 1 ]; then",
            "if true; then",
        ),
        (
            "error_file=\"$RUNNER_TEMP/npm-view-error\"",
            "npm publish --access public --provenance --ignore-scripts\n          error_file=\"$RUNNER_TEMP/npm-view-error\"",
        ),
        (
            "if npm publish --access public --provenance --ignore-scripts; then",
            "env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}\n          if npm publish --access public --provenance; then",
        ),
        (
            "npm publish --access public --provenance --ignore-scripts",
            "npm publish --access public --provenance",
        ),
        (
            "npm pack --ignore-scripts --dry-run --json",
            "npm pack --dry-run --json",
        ),
        (
            "for verification_attempt in {1..10}; do",
            "for verification_attempt in {1..1}; do",
        ),
        ("if registry_matches; then", "if false; then"),
    ] {
        let mutated = mutate_registry(&workflow, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
}

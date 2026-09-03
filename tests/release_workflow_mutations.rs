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
fn release_contract_rejects_critical_workflow_mutations() {
    let workflow = normalized_workflow(RELEASE_WORKFLOW);
    assert_eq!(release_contract(&workflow), Ok(()));
    for (before, after) in [
        (
            "[ \"$sha\" = \"$(git rev-parse origin/main)\" ]",
            ": # skipped exact main validation",
        ),
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
        (".[0].draft | type", ".[0].draft"),
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
        ("any(.verified[];", "any([][];"),
        (
            "error_file=\"$RUNNER_TEMP/npm-view-error\"",
            "npm publish --access public --provenance\n          error_file=\"$RUNNER_TEMP/npm-view-error\"",
        ),
        ("[ \"$actual_assets\" = \"$expected_names\" ]", "true # skipped exact asset equality"),
        ("' <<< \"$audit\" >/dev/null", "' <<< \"$audit\" >/dev/null || true"),
    ] {
        let mutated = mutate_registry(&workflow, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
}

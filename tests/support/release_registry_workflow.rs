use super::{before, require, step};

pub(super) fn validate(workflow: &str, registry: &str) -> Result<(), String> {
    before(
        registry,
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
        "- name: Verify public Release assets",
    )?;
    let assets = step(registry, "Verify public Release assets");
    for required in [
        ".tag_name",
        "expected_assets=(",
        "[.assets[].name] | sort | join",
        "actual_assets",
        "[ \"$actual_assets\" = \"$expected_names\" ]",
        "gh release download",
        "sha256sum \"$directory/$asset\"",
        "[ \"$actual\" = \"$expected\" ]",
    ] {
        require(assets, required)?;
    }
    before(assets, "actual_assets", "gh release download")?;

    let inspection = registry
        .split_once("      - id: registry\n")
        .and_then(|(_, steps)| steps.split_once("\n      - name: Publish missing package"))
        .map(|(inspection, _)| inspection)
        .ok_or("missing registry state inspection")?;
    if inspection.contains("npm publish") {
        return Err("registry state inspection publishes a package".to_owned());
    }
    for required in [
        "if [ \"$GITHUB_RUN_ATTEMPT\" -eq 1 ]; then",
        "for attempt in {1..10}; do",
        "sleep 2",
    ] {
        require(inspection, required)?;
    }
    let publish = step(registry, "Publish missing package");
    require(publish, "npm publish --access public --provenance")?;
    require(publish, "if npm publish --access public --provenance; then")?;
    require(
        publish,
        "npm publish reported failure; checking registry visibility",
    )?;
    if publish.contains("NODE_AUTH_TOKEN") || workflow.contains("NPM_PUBLISH_TOKEN") {
        return Err("registry publishing must use trusted publishing OIDC only".to_owned());
    }

    let provenance = step(registry, "Verify registry package and provenance");
    for required in [
        "actual=\"$RUNNER_TEMP/npm-package-verified.json\"",
        "npm view \"$package@$version\" --json > \"$actual\"",
        "npm install --ignore-scripts --package-lock=false",
        "npm audit signatures --json --include-attestations",
        ".verified[]?",
        "registry_matches() {",
        "normalize_repository_url() {",
        "expected_repository=\"$(normalize_repository_url \"$(node -p \"require('./package.json').repository.url\")\")\"",
        "registry_repository=\"$(normalize_repository_url \"$(jq -r '.repository.url' \"$actual\")\")\"",
        ".bundle.dsseEnvelope.payload",
        "Buffer.from(process.argv[1], \"base64\")",
        ".github/workflows/release.yml",
        "refs/tags/$TAG",
        "$TAG_SHA",
        "$GITHUB_RUN_ID",
        "expected_run=\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"",
        "startswith($run + \"/attempts/\")",
        "ltrimstr($run + \"/attempts/\") | test(\"^[0-9]+$\")",
        "$provenance_workflow.repository == $repository",
        "$provenance_workflow.path == $workflow",
        "$provenance_workflow.ref == $ref",
        ".digest.gitCommit == $sha",
        "--arg run \"$expected_run\"",
        "for verification_attempt in {1..10}; do",
        "if registry_matches; then",
    ] {
        require(provenance, required)?;
    }
    if provenance.contains("--no-save") {
        return Err("provenance audit must install a direct package dependency".to_owned());
    }
    if provenance.contains("|| true") {
        return Err("provenance verification may not suppress errors".to_owned());
    }
    if provenance.contains("GITHUB_RUN_ATTEMPT") {
        return Err("provenance verification must bind a stable GitHub run ID".to_owned());
    }
    before(
        provenance,
        "npm view \"$package@$version\" --json > \"$actual\"",
        "[ \"$(jq -r '.name' \"$actual\")\" = \"$package\" ]",
    )?;
    before(
        registry,
        "Verify public Release assets",
        "Publish missing package",
    )?;
    before(
        registry,
        "Publish missing package",
        "Verify registry package and provenance",
    )
}

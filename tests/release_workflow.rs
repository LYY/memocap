const RELEASE_WORKFLOW: &str = include_str!("../.github/workflows/release.yml");
const CI_WORKFLOW: &str = include_str!("../.github/workflows/ci.yml");

fn job<'a>(workflow: &'a str, name: &str) -> &'a str {
    let marker = format!("  {name}:\n");
    let (_, remainder) = workflow
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing job {name}"));
    let end = remainder.match_indices('\n').find_map(|(index, _)| {
        let next = &remainder[index + 1..];
        (next.starts_with("  ") && !next.starts_with("   ")).then_some(index)
    });
    &remainder[..end.unwrap_or(remainder.len())]
}

fn step<'a>(section: &'a str, name: &str) -> &'a str {
    let marker = format!("      - name: {name}\n");
    let (_, remainder) = section
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing step {name}"));
    &remainder[..remainder.find("\n      - ").unwrap_or(remainder.len())]
}

fn permissions(section: &str, indent: usize) -> Vec<(&str, &str)> {
    let prefix = " ".repeat(indent);
    let (_, remainder) = section
        .split_once(&format!("{prefix}permissions:\n"))
        .expect("missing permissions map");
    remainder
        .lines()
        .take_while(|line| line.starts_with(&format!("{prefix}  ")))
        .map(|line| {
            line.trim()
                .split_once(": ")
                .expect("permission must use key: value")
        })
        .collect()
}

fn require(text: &str, expected: &str) -> Result<(), String> {
    text.contains(expected)
        .then_some(())
        .ok_or_else(|| format!("missing {expected}"))
}

fn before(text: &str, first: &str, second: &str) -> Result<(), String> {
    let first = text.find(first).ok_or_else(|| format!("missing {first}"))?;
    let second = text
        .find(second)
        .ok_or_else(|| format!("missing {second}"))?;
    (first < second)
        .then_some(())
        .ok_or_else(|| format!("{first} must precede {second}"))
}

fn release_contract(workflow: &str) -> Result<(), String> {
    let trigger = workflow
        .split_once("on:\n")
        .and_then(|(_, after)| after.split_once("permissions:\n"))
        .map(|(trigger, _)| trigger.trim())
        .ok_or_else(|| "missing trigger block".to_owned())?;
    if trigger != "push:\n    tags: [\"v*\"]" || workflow.contains("workflow_dispatch") {
        return Err("release must be tag-only".to_owned());
    }
    for required in [
        "fetch-depth: 0",
        "git merge-base --is-ancestor \"$sha\" origin/main",
        "scripts/check-release.mjs",
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    ] {
        require(workflow, required)?;
    }

    let validate = workflow.find("  validate:\n").ok_or("missing validate")?;
    let binaries = workflow.find("  binaries:\n").ok_or("missing binaries")?;
    let release = workflow.find("  release:\n").ok_or("missing release")?;
    let registry = workflow.find("  registry:\n").ok_or("missing registry")?;
    if !(validate < binaries && binaries < release && release < registry) {
        return Err("jobs out of order".to_owned());
    }
    require(job(workflow, "binaries"), "needs: validate")?;
    require(job(workflow, "release"), "needs: [validate, binaries]")?;
    require(job(workflow, "registry"), "needs: [validate, release]")?;

    if permissions(workflow, 0) != vec![("contents", "read")]
        || permissions(job(workflow, "validate"), 4) != vec![("contents", "read")]
        || permissions(job(workflow, "binaries"), 4) != vec![("contents", "read")]
        || permissions(job(workflow, "release"), 4) != vec![("contents", "write")]
        || permissions(job(workflow, "registry"), 4)
            != vec![("contents", "read"), ("id-token", "write")]
    {
        return Err("permissions are not least privilege".to_owned());
    }

    let reconcile = job(workflow, "release");
    let draft = reconcile
        .split_once("draft)\n")
        .map(|(_, branch)| branch.split(";;").next().unwrap_or(branch))
        .ok_or("missing draft branch")?;
    before(
        draft,
        "verify_existing_assets \"$release\"",
        "gh release upload",
    )?;
    let public = reconcile
        .split_once("public)\n")
        .map(|(_, branch)| branch.split(";;").next().unwrap_or(branch))
        .ok_or("missing public branch")?;
    for write in ["gh release create", "gh release upload", "gh release edit"] {
        if public.contains(write) {
            return Err(format!("public branch writes via {write}"));
        }
    }

    let registry = job(workflow, "registry");
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
        "gh release download",
        "sha256sum \"$directory/$asset\"",
        "[ \"$actual\" = \"$expected\" ]",
    ] {
        require(assets, required)?;
    }
    before(assets, "actual_assets", "gh release download")?;

    let provenance = step(registry, "Verify registry package and provenance");
    for required in [
        "npm install --ignore-scripts --package-lock=false",
        "npm audit signatures --json --include-attestations",
        "any(.verified[];",
        ".attestations.provenance.predicateType == \"https://slsa.dev/provenance/v1\"",
    ] {
        require(provenance, required)?;
    }
    if provenance.contains("--no-save") {
        return Err("provenance audit must install a direct package dependency".to_owned());
    }
    before(
        registry,
        "Verify public Release assets",
        "Publish missing package",
    )?;
    before(
        registry,
        "Publish missing package",
        "Verify registry package and provenance",
    )?;

    for reference in workflow
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- uses: "))
    {
        let (_, revision) = reference
            .split_once('@')
            .ok_or_else(|| format!("action reference missing @: {reference}"))?;
        if revision.len() != 40 || !revision.chars().all(|value| value.is_ascii_hexdigit()) {
            return Err(format!("action is not SHA pinned: {reference}"));
        }
    }
    if workflow.contains("--clobber") || workflow.contains("overwrite:") {
        return Err("release may overwrite assets".to_owned());
    }
    Ok(())
}

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
fn actual_release_workflow_enforces_release_and_registry_contract() {
    assert_eq!(release_contract(RELEASE_WORKFLOW), Ok(()));
}

#[test]
fn release_contract_rejects_critical_workflow_mutations() {
    assert_eq!(release_contract(RELEASE_WORKFLOW), Ok(()));
    for (before, after) in [
        (
            "git merge-base --is-ancestor \"$sha\" origin/main",
            ": # skipped ancestor validation",
        ),
        (
            "verify_existing_assets \"$release\"",
            ": # skipped asset verification",
        ),
    ] {
        let mutated = mutate(RELEASE_WORKFLOW, before, after);
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
    ] {
        let mutated = mutate_registry(RELEASE_WORKFLOW, before, after);
        assert!(
            release_contract(&mutated).is_err(),
            "mutation accepted: {before}"
        );
    }
}

#[test]
fn ci_package_contract_runs_release_gates_before_packaging() {
    let package_contract = job(CI_WORKFLOW, "package-contract");
    assert_eq!(permissions(package_contract, 4), vec![("contents", "read")]);
    for required in [
        "actionlint_1.7.12_linux_amd64.tar.gz",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        "scripts/check-release.mjs",
        "node --check",
        "node --test tests/*.test.cjs",
        "npm pack --dry-run --json",
    ] {
        assert!(
            package_contract.contains(required),
            "missing CI check {required}"
        );
    }
    assert!(
        package_contract.find("actionlint").unwrap() < package_contract.find("npm pack").unwrap()
    );
}

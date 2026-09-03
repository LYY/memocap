pub const RELEASE_WORKFLOW: &str = include_str!("../../.github/workflows/release.yml");
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

pub fn release_contract(workflow: &str) -> Result<(), String> {
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
    let initial_read = "release=\"$(read_release)\"";
    let initial_read_position = reconcile
        .find(initial_read)
        .ok_or("missing initial release read")?;
    let state_machine = &reconcile[initial_read_position..];
    for command in reconcile
        .lines()
        .map(str::trim_start)
        .filter(|line| line.starts_with("gh release "))
    {
        if command.starts_with("gh release download ") {
            continue;
        }
        if ![
            "gh release create ",
            "gh release upload ",
            "gh release edit ",
        ]
        .iter()
        .any(|allowed| command.starts_with(allowed))
        {
            return Err(format!("unexpected gh release command: {command}"));
        }
    }
    for write in ["gh release create", "gh release upload", "gh release edit"] {
        if reconcile.matches(write).count() != 1 {
            return Err(format!("expected one release write via {write}"));
        }
        if reconcile
            .find(write)
            .is_some_and(|position| position < initial_read_position)
        {
            return Err(format!("release writes before initial read via {write}"));
        }
    }
    before(
        state_machine,
        "gh release create",
        "verify_identity \"$release\"",
    )?;
    before(
        state_machine,
        "verify_identity \"$release\"",
        "case \"$state\" in",
    )?;
    let draft = reconcile
        .split_once("draft)\n")
        .map(|(_, branch)| branch.split(";;").next().unwrap_or(branch))
        .ok_or("missing draft branch")?;
    let validation = "verify_existing_assets \"$release\"";
    let before_validation = draft
        .split_once(validation)
        .map(|(before, _)| before)
        .ok_or("missing draft asset validation")?;
    for write in ["gh release create", "gh release upload", "gh release edit"] {
        if before_validation.contains(write) {
            return Err(format!(
                "draft branch writes before asset validation via {write}"
            ));
        }
    }
    before(draft, validation, "gh release upload")?;
    before(
        draft,
        "gh release upload",
        "verify_known_assets \"$release\"",
    )?;
    before(draft, "verify_known_assets \"$release\"", "gh release edit")?;
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

    let provenance = step(registry, "Verify registry package and provenance");
    for required in [
        "actual=\"$RUNNER_TEMP/npm-package-verified.json\"",
        "npm view \"$package@$version\" --json > \"$actual\"",
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
    if provenance.contains("|| true") {
        return Err("provenance verification may not suppress errors".to_owned());
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

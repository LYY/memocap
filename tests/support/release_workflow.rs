pub const RELEASE_WORKFLOW: &str = include_str!("../../.github/workflows/release.yml");

#[path = "release_registry_workflow.rs"]
mod release_registry_workflow;

pub fn normalized_workflow(workflow: &str) -> String {
    workflow.replace("\r\n", "\n")
}

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
    let normalized = normalized_workflow(workflow);
    let workflow = normalized.as_str();
    let trigger = workflow
        .split_once("on:\n")
        .and_then(|(_, after)| after.split_once("concurrency:\n"))
        .map(|(trigger, _)| trigger.trim())
        .ok_or_else(|| "missing trigger block".to_owned())?;
    if trigger != "push:\n    tags: [\"v*\"]" || workflow.contains("workflow_dispatch") {
        return Err("release must be tag-only".to_owned());
    }
    let concurrency = workflow
        .split_once("concurrency:\n")
        .and_then(|(_, after)| after.split_once("permissions:\n"))
        .map(|(concurrency, _)| concurrency.trim())
        .ok_or_else(|| "missing release concurrency".to_owned())?;
    if concurrency
        != "group: release-${{ github.repository }}-${{ github.ref_name }}\n  cancel-in-progress: false"
    {
        return Err("release concurrency must serialize each repository tag".to_owned());
    }
    for required in [
        "fetch-depth: 0",
        "git fetch --no-tags origin main",
        "git merge-base --is-ancestor \"$sha\" origin/main",
        "gh run list \\",
        "--workflow CI \\",
        "--event push \\",
        "--branch main \\",
        "--commit \"$sha\" \\",
        "--status completed \\",
        "--json conclusion,event,headBranch,headSha,name",
        "any(.[]; .name == \"CI\" and .event == \"push\" and .headBranch == \"main\" and .headSha == $sha and .conclusion == \"success\")",
        "GITHUB_WORKFLOW_SHA",
        "GITHUB_WORKFLOW_REF",
        "tag_workflow=\"$(git rev-parse \"$sha:.github/workflows/release.yml\")\"",
        "workflow_identity=\"$(git rev-parse \"$GITHUB_WORKFLOW_SHA:.github/workflows/release.yml\")\"",
        "expected_workflow_ref=\"$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/tags/$tag\"",
        "[ \"$workflow_identity\" = \"$tag_workflow\" ]",
        "[ \"$GITHUB_WORKFLOW_REF\" = \"$expected_workflow_ref\" ]",
        "Set-Content -NoNewline -Encoding ascii",
        "scripts/check-release.mjs",
    ] {
        require(workflow, required)?;
    }

    let validate = workflow.find("  validate:\n").ok_or("missing validate")?;
    let binaries = workflow.find("  binaries:\n").ok_or("missing binaries")?;
    let registry = workflow.find("  registry:\n").ok_or("missing registry")?;
    if !(validate < binaries && binaries < registry) {
        return Err("jobs out of order".to_owned());
    }
    require(job(workflow, "binaries"), "needs: validate")?;
    require(job(workflow, "registry"), "needs: [validate, binaries]")?;
    require(job(workflow, "registry"), "environment: npm-release")?;

    if permissions(workflow, 0) != vec![("contents", "read"), ("actions", "read")]
        || permissions(job(workflow, "validate"), 4)
            != vec![("contents", "read"), ("actions", "read")]
        || permissions(job(workflow, "binaries"), 4) != vec![("contents", "read")]
        || permissions(job(workflow, "registry"), 4)
            != vec![("contents", "read"), ("id-token", "write")]
    {
        return Err("permissions are not least privilege".to_owned());
    }

    release_registry_workflow::validate(workflow, job(workflow, "registry"))?;

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
    if workflow.contains("  release:\n")
        || workflow.contains("contents: write")
        || workflow.contains("gh release ")
        || workflow.contains("workflow_dispatch")
        || workflow.contains("--clobber")
        || workflow.contains("overwrite:")
        || workflow.contains("release_recovery_sha")
    {
        return Err("release may overwrite assets or allow historical recovery".to_owned());
    }
    Ok(())
}

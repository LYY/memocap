const RELEASE_WORKFLOW: &str = include_str!("../.github/workflows/release.yml");
const CI_WORKFLOW: &str = include_str!("../.github/workflows/ci.yml");

#[derive(Clone, Copy)]
enum ReleaseState {
    Absent,
    Draft { assets_match: bool },
    Public { exact: bool },
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

fn action_references(workflow: &str) -> Vec<&str> {
    workflow
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- uses: "))
        .collect()
}

fn reconciliation_writes(state: ReleaseState) -> Result<Vec<&'static str>, &'static str> {
    match state {
        ReleaseState::Absent => Ok(vec!["create", "upload", "publish"]),
        ReleaseState::Draft { assets_match } => {
            if assets_match {
                Ok(vec!["publish"])
            } else {
                Ok(vec!["upload", "publish"])
            }
        }
        ReleaseState::Public { exact: true } => Ok(Vec::new()),
        ReleaseState::Public { exact: false } => Err("public release mismatch"),
    }
}

#[test]
fn release_workflow_is_tag_only_and_validates_before_effects() {
    let trigger = RELEASE_WORKFLOW
        .split_once("on:\n")
        .and_then(|(_, after)| after.split_once("permissions:\n"))
        .map(|(trigger, _)| trigger.trim())
        .expect("release workflow must contain trigger block");

    assert_eq!(trigger, "push:\n    tags: [\"v*\"]");
    assert!(!RELEASE_WORKFLOW.contains("workflow_dispatch"));
    assert!(RELEASE_WORKFLOW.contains("fetch-depth: 0"));
    assert!(RELEASE_WORKFLOW.contains("git merge-base --is-ancestor"));
    assert!(RELEASE_WORKFLOW.contains("scripts/check-release.mjs"));

    let validate = RELEASE_WORKFLOW.find("  validate:\n").unwrap();
    let binaries = RELEASE_WORKFLOW.find("  binaries:\n").unwrap();
    let release = RELEASE_WORKFLOW.find("  release:\n").unwrap();
    let registry = RELEASE_WORKFLOW.find("  registry:\n").unwrap();
    assert!(validate < binaries && binaries < release && release < registry);
    assert!(job(RELEASE_WORKFLOW, "binaries").contains("needs: validate"));
    assert!(job(RELEASE_WORKFLOW, "release").contains("needs: [validate, binaries]"));
    assert!(job(RELEASE_WORKFLOW, "registry").contains("needs: [validate, release]"));
}

#[test]
fn release_workflow_uses_exact_permission_maps_and_step_scoped_secret() {
    let (_, workflow_jobs) = RELEASE_WORKFLOW.split_once("jobs:\n").unwrap();
    assert_eq!(permissions(RELEASE_WORKFLOW, 0), vec![("contents", "read")]);
    assert_eq!(
        permissions(job(workflow_jobs, "validate"), 4),
        vec![("contents", "read")]
    );
    assert_eq!(
        permissions(job(workflow_jobs, "binaries"), 4),
        vec![("contents", "read")]
    );
    assert_eq!(
        permissions(job(workflow_jobs, "release"), 4),
        vec![("contents", "write")]
    );
    assert_eq!(
        permissions(job(workflow_jobs, "registry"), 4),
        vec![("contents", "read"), ("id-token", "write")]
    );

    let registry = job(workflow_jobs, "registry");
    let publish = registry
        .split_once("- name: Publish missing package\n")
        .map(|(_, step)| step.split("\n      - ").next().unwrap_or(step))
        .expect("missing publish step");
    assert_eq!(
        RELEASE_WORKFLOW
            .matches("secrets.NPM_PUBLISH_TOKEN")
            .count(),
        1
    );
    assert!(publish.contains("NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}"));
}

#[test]
fn workflow_contract_pins_actions_assets_and_never_overwrites() {
    for workflow in [RELEASE_WORKFLOW, CI_WORKFLOW] {
        for reference in action_references(workflow) {
            let (_, revision) = reference
                .split_once('@')
                .expect("action reference missing @");
            assert_eq!(revision.len(), 40, "action must be SHA pinned: {reference}");
            assert!(revision.chars().all(|value| value.is_ascii_hexdigit()));
        }
    }
    assert!(RELEASE_WORKFLOW
        .contains("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"));
    assert!(RELEASE_WORKFLOW
        .contains("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"));
    assert!(!RELEASE_WORKFLOW.contains("--clobber"));
    assert!(!RELEASE_WORKFLOW.contains("overwrite:"));

    for (target, asset) in [
        (
            "x86_64-unknown-linux-gnu",
            "memocap-x86_64-unknown-linux-gnu",
        ),
        ("aarch64-apple-darwin", "memocap-aarch64-apple-darwin"),
        (
            "x86_64-pc-windows-msvc",
            "memocap-x86_64-pc-windows-msvc.exe",
        ),
    ] {
        assert!(RELEASE_WORKFLOW.contains(target));
        assert!(RELEASE_WORKFLOW.contains(asset));
    }
}

#[test]
fn exact_public_release_fixture_performs_no_writes() {
    assert_eq!(
        reconciliation_writes(ReleaseState::Public { exact: true }).unwrap(),
        Vec::<&str>::new()
    );
    assert!(reconciliation_writes(ReleaseState::Public { exact: false }).is_err());
    assert_eq!(
        reconciliation_writes(ReleaseState::Absent).unwrap(),
        vec!["create", "upload", "publish"]
    );
    assert_eq!(
        reconciliation_writes(ReleaseState::Draft {
            assets_match: false
        })
        .unwrap(),
        vec!["upload", "publish"]
    );

    let reconcile = job(RELEASE_WORKFLOW, "release");
    let draft_branch = reconcile
        .split_once("draft)\n")
        .map(|(_, branch)| branch.split(";;").next().unwrap_or(branch))
        .expect("missing draft reconciliation branch");
    assert!(
        draft_branch
            .find("verify_existing_assets \"$release\"")
            .unwrap()
            < draft_branch.find("gh release upload").unwrap()
    );
    let public_branch = reconcile
        .split_once("public)\n")
        .map(|(_, branch)| branch.split(";;").next().unwrap_or(branch))
        .expect("missing public reconciliation branch");
    for write in ["gh release create", "gh release upload", "gh release edit"] {
        assert!(
            !public_branch.contains(write),
            "public branch writes via {write}"
        );
    }
}

#[test]
fn ci_package_contract_runs_release_gates_before_packaging() {
    let package_contract = job(CI_WORKFLOW, "package-contract");
    assert_eq!(
        permissions(job(CI_WORKFLOW, "package-contract"), 4),
        vec![("contents", "read")]
    );
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

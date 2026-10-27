const CI_WORKFLOW: &str = include_str!("../.github/workflows/ci.yml");

fn job<'a>(workflow: &'a str, name: &str) -> &'a str {
    let marker = format!("  {name}:");
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
        .split_once(&format!("{prefix}permissions:"))
        .expect("missing permissions map");
    let remainder = remainder
        .strip_prefix("\r\n")
        .or_else(|| remainder.strip_prefix('\n'))
        .expect("permissions must end with a line break");
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

#[test]
fn package_contract_runs_release_gates_before_packaging() {
    let package_contract = job(CI_WORKFLOW, "package-contract");
    assert_eq!(permissions(package_contract, 4), vec![("contents", "read")]);
    for required in [
        "actionlint_1.7.12_linux_amd64.tar.gz",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        "scripts/check-release.mjs",
        "RELEASE_TAG: v0.3.0",
        "node --check",
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
    assert!(!package_contract.contains("node --test tests/*.test.cjs"));
}

#[test]
fn package_contract_accepts_windows_crlf_checkout() {
    let windows_workflow = CI_WORKFLOW.replace("\r\n", "\n").replace('\n', "\r\n");

    let package_contract = job(&windows_workflow, "package-contract");

    assert_eq!(permissions(package_contract, 4), vec![("contents", "read")]);
}

#[test]
fn platform_matrix_runs_node_contracts() {
    assert_node_contract(CI_WORKFLOW);
}

#[test]
fn platform_matrix_runs_node_contracts_on_crlf_checkout() {
    let windows_workflow = windows_workflow(CI_WORKFLOW);

    assert_node_contract(&windows_workflow);
}

#[test]
fn platform_matrix_runs_node_contracts_after_windows_checkout() {
    let checked_out_windows = windows_workflow(CI_WORKFLOW);
    let windows_workflow = windows_workflow(&checked_out_windows);

    assert_node_contract(&windows_workflow);
}

fn windows_workflow(workflow: &str) -> String {
    workflow.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn assert_node_contract(workflow: &str) {
    let test = job(workflow, "test").replace("\r\n", "\n");

    assert!(test.contains("os: [ubuntu-latest, macos-latest, windows-latest]"));
    assert!(test.contains("node-version: \"24\""));
    assert!(test.find("npm ci --ignore-scripts").unwrap() < test.find("node --test").unwrap());
    assert!(step_running(&test, "node --test tests/*.test.cjs")
        .contains("if: ${{ !cancelled() && steps.native_build.outcome == 'success' }}"));
}

fn step_running<'a>(section: &'a str, command: &str) -> &'a str {
    section
        .split("\n      - ")
        .find(|step| {
            step.lines()
                .any(|line| line.trim() == format!("run: {command}") || line.trim() == command)
        })
        .unwrap_or_else(|| panic!("missing command {command}"))
}

#[test]
fn native_build_precedes_rust_tests_and_node_feedback() {
    let test = job(CI_WORKFLOW, "test").replace("\r\n", "\n");

    let build = step_running(&test, "cargo build --bin memocap");

    assert!(build.lines().any(|line| line.trim() == "id: native_build"));
    let commands = [
        "cargo build --bin memocap",
        "cargo test",
        "node --test tests/*.test.cjs",
        "node --test tests/opencode-v1.integration.test.cjs",
    ];
    for pair in commands.windows(2) {
        assert!(test.find(pair[0]).unwrap() < test.find(pair[1]).unwrap());
    }
    for command in commands {
        assert_eq!(test.matches(command).count(), 1);
    }
}

#[test]
fn node_and_host_feedback_require_successful_native_build_without_cancellation() {
    let test = job(CI_WORKFLOW, "test").replace("\r\n", "\n");

    for command in [
        "node --test tests/*.test.cjs",
        "node --test tests/opencode-v1.integration.test.cjs",
    ] {
        let step = step_running(&test, command);
        let conditions: Vec<_> = step
            .lines()
            .filter(|line| line.trim().starts_with("if:"))
            .map(str::trim)
            .collect();

        assert_eq!(
            conditions,
            ["if: ${{ !cancelled() && steps.native_build.outcome == 'success' }}"]
        );
    }
}

#[test]
fn rust_gates_retain_default_failure_semantics() {
    let test = job(CI_WORKFLOW, "test").replace("\r\n", "\n");

    for command in [
        "cargo fmt --check",
        "cargo clippy --all-targets -- -D warnings",
        "cargo build --bin memocap",
        "cargo test",
    ] {
        let step = step_running(&test, command);

        assert!(!step.lines().any(|line| line.trim().starts_with("if:")));
    }
    assert!(!CI_WORKFLOW.contains("continue-on-error:"));
}

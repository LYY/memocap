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
    let windows_workflow = CI_WORKFLOW.replace('\n', "\r\n");

    assert_node_contract(&windows_workflow);
}

fn assert_node_contract(workflow: &str) {
    let test = job(workflow, "test").replace("\r\n", "\n");

    assert!(test.contains("os: [ubuntu-latest, macos-latest, windows-latest]"));
    assert!(test.contains("- name: Test Node contracts\n        run: node --test tests/*.test.cjs"));
}

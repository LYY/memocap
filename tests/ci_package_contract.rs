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

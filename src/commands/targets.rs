use anyhow::{ensure, Result};
use memocap::{receipt::Target, scope};

pub(super) fn resolve(command: &crate::Command, options: &crate::Cli) -> Result<Vec<Target>> {
    let targets = if let Some(json) = &options.targets_json {
        serde_json::from_str::<Vec<Target>>(json)?
    } else if !options.repository_id.is_empty() {
        options
            .repository_id
            .iter()
            .map(|repository| Target {
                canonical_path: None,
                repository_id: repository.clone(),
                identity_source: "selected-id".into(),
                descriptor: None,
                observed_at: None,
                placements: vec![repository.to_string()],
            })
            .collect()
    } else {
        let implicit = options.repo.is_empty();
        let paths = if implicit {
            vec![std::env::current_dir()?]
        } else {
            options.repo.clone()
        };
        ensure!(paths.len() <= 8, "at most eight targets are supported");
        paths
            .iter()
            .map(|path| {
                let path = path.canonicalize()?;
                let pure = matches!(
                    command,
                    crate::Command::Scope {
                        command: crate::ScopeCommand::Resolve
                    } | crate::Command::Status { read_only: true }
                        | crate::Command::Activity { .. }
                );
                let resolved = if pure || !implicit {
                    scope::resolve_readonly(&path)?
                } else {
                    scope::resolve(&path)?
                };
                let repository_id = resolved.repository().clone();
                Ok(Target {
                    descriptor: scope::descriptor(&path)?,
                    canonical_path: Some(path),
                    placements: vec![repository_id.to_string()],
                    repository_id,
                    identity_source: resolved.source().label().into(),
                    observed_at: Some(chrono::Utc::now().to_rfc3339()),
                })
            })
            .collect::<Result<Vec<_>>>()?
    };
    ensure!(
        !targets.is_empty() && targets.len() <= 8,
        "one to eight targets are required"
    );
    let mut unique = Vec::new();
    for target in targets {
        target.validate()?;
        if !unique.iter().any(|existing: &Target| {
            match (&existing.canonical_path, &target.canonical_path) {
                (Some(left), Some(right)) => left == right,
                (None, None) => existing.repository_id == target.repository_id,
                _ => false,
            }
        }) {
            unique.push(target);
        }
    }
    Ok(unique)
}

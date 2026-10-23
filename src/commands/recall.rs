use anyhow::{bail, Result};
use memocap::{
    cli,
    config::{self, Target},
    store,
};

use super::remote::RemoteSession;

pub(crate) fn run(
    targets: &[cli::RepositoryTarget],
    selector: Option<cli::PlacementSelector>,
    options: store::RecallOptions<'_>,
) -> Result<()> {
    let memories = match config::resolve_target()? {
        Target::Local { database } => {
            let repositories = targets
                .iter()
                .map(|target| target.scope.repository().clone())
                .collect::<Vec<_>>();
            cli::recall_targeted(
                &database,
                cli::TargetedRecall {
                    repositories: &repositories,
                    selector: selector.as_ref(),
                    options,
                },
            )?
        }
        Target::Remote { address, token } => {
            match options.match_mode {
                store::MatchMode::All => {}
                store::MatchMode::Any => {
                    bail!("remote --match any requires the recall match capability")
                }
            }
            let mut batches = Vec::with_capacity(targets.len());
            for target in targets {
                let session = RemoteSession::new(&address, &token, target.scope.clone());
                batches.push(store::TargetRecall {
                    repository: target.scope.repository().clone(),
                    memories: session.recall(
                        selector.clone(),
                        cli::ScopedRecall {
                            query: options.query,
                            limit: usize::try_from(i64::MAX).unwrap_or(usize::MAX),
                            kind: options.kind,
                            max_chars: None,
                        },
                    )?,
                });
            }
            store::merge_recalled(batches, options)?
        }
    };
    print!("{}", cli::format_targeted_memories(&memories));
    Ok(())
}

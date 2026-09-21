use anyhow::Result;

use memocap::{
    cli::{self, PlacementSelector, ScopedRecall, ScopedRemember},
    remote,
    scope::{PlacementId, RepositoryId, ResolvedScope},
    store::{CopyMoveInput, CopyMoveRequest, CopyMoveResult, InventoryMemory},
};

use crate::DomainCommand;

pub(crate) struct RemoteSession<'a> {
    address: &'a str,
    token: &'a str,
    scope: ResolvedScope,
}

impl<'a> RemoteSession<'a> {
    pub(crate) fn current(address: &'a str, token: &'a str) -> Result<Self> {
        Ok(Self {
            address,
            token,
            scope: cli::current_scope()?,
        })
    }

    pub(crate) fn remember(
        &self,
        selector: Option<PlacementSelector>,
        memory: ScopedRemember<'_>,
    ) -> Result<i64> {
        let placement = self.exact_placement(selector);
        remote::remember(
            self.address,
            self.token,
            remote::RememberRequest {
                repository: self.repository(),
                placement: &placement,
                content: memory.content,
                kind: memory.kind,
                tags: memory.tags,
                topic_key: memory.topic,
                force: memory.force,
                overwrite_id: memory.overwrite_id,
            },
        )
    }

    pub(crate) fn recall(
        &self,
        selector: Option<PlacementSelector>,
        query: ScopedRecall<'_>,
    ) -> Result<Vec<InventoryMemory>> {
        let placement = self.selected_placement(selector);
        remote::recall(
            self.address,
            self.token,
            remote::RecallRequest {
                repository: self.repository(),
                placement: placement.as_ref(),
                query: query.query,
                limit: query.limit,
                kind: query.kind,
                max_chars: query.max_chars,
            },
        )
    }

    pub(crate) fn list(
        &self,
        selector: Option<PlacementSelector>,
        limit: usize,
    ) -> Result<Vec<InventoryMemory>> {
        let placement = self.selected_placement(selector);
        remote::list(
            self.address,
            self.token,
            self.repository(),
            placement.as_ref(),
            limit,
        )
    }

    pub(crate) fn forget(&self, selector: Option<PlacementSelector>, id: i64) -> Result<bool> {
        let placement = self.exact_placement(selector);
        remote::forget(self.address, self.token, self.repository(), &placement, id)
    }

    pub(crate) fn scope_show(&self) -> Result<String> {
        let status = remote::status(self.address, self.token, self.repository())?;
        Ok(cli::format_scope_show(&self.scope, &status.domains))
    }

    pub(crate) fn copy_move(&self, input: CopyMoveInput) -> Result<CopyMoveResult> {
        let request = CopyMoveRequest::prepare(self.repository().clone(), input)?;
        remote::copy_move(self.address, self.token, &request)
    }

    pub(crate) fn domain(&self, command: DomainCommand) -> Result<()> {
        match command {
            DomainCommand::Create { domain } => {
                changed_message(
                    remote::create_domain(self.address, self.token, self.repository(), &domain)?,
                    format!("created domain {domain}"),
                    format!("domain already exists {domain}"),
                );
            }
            DomainCommand::Attach { domain, before } => {
                changed_message(
                    remote::attach_domain(
                        self.address,
                        self.token,
                        self.repository(),
                        &domain,
                        before.as_ref(),
                    )?,
                    format!("attached domain {domain}"),
                    format!("domain already attached {domain}"),
                );
            }
            DomainCommand::Detach { domain } => {
                changed_message(
                    remote::detach_domain(self.address, self.token, self.repository(), &domain)?,
                    format!("detached domain {domain}"),
                    format!("domain not attached {domain}"),
                );
            }
            DomainCommand::List { all } => {
                print!(
                    "{}",
                    cli::format_domains(&remote::domains(
                        self.address,
                        self.token,
                        self.repository(),
                        all,
                    )?)
                );
            }
            DomainCommand::Delete { domain } => {
                changed_message(
                    remote::delete_domain(self.address, self.token, self.repository(), &domain)?,
                    format!("deleted domain {domain}"),
                    format!("domain not found {domain}"),
                );
            }
        }
        Ok(())
    }

    fn repository(&self) -> &RepositoryId {
        self.scope.repository()
    }

    fn exact_placement(&self, selector: Option<PlacementSelector>) -> PlacementId {
        match selector {
            Some(PlacementSelector::Domain(domain)) => PlacementId::Domain(domain),
            Some(PlacementSelector::Universal) => PlacementId::Universal,
            None => PlacementId::Repository(self.repository().clone()),
        }
    }

    fn selected_placement(&self, selector: Option<PlacementSelector>) -> Option<PlacementId> {
        selector.map(|selector| self.exact_placement(Some(selector)))
    }
}

pub(crate) fn operation_status(
    address: &str,
    token: &str,
    recovery: &remote::RecoveryHandle,
) -> Result<()> {
    match remote::operation_status(address, token, recovery)? {
        remote::OperationStatus::Committed(result) => print!("{}", cli::format_copy_move(&result)),
        remote::OperationStatus::NotFound => println!("not_found"),
        remote::OperationStatus::Unknown => println!("outcome unknown"),
    }
    Ok(())
}

fn changed_message(changed: bool, changed_text: String, unchanged_text: String) {
    println!(
        "{}",
        if changed {
            changed_text
        } else {
            unchanged_text
        }
    );
}

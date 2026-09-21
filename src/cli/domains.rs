use std::path::Path;

use anyhow::Result;

use crate::{
    scope::{DomainId, RepositoryId, ResolvedScope},
    store,
};

pub fn create_domain(database: &Path, domain: &DomainId) -> Result<bool> {
    store::create_domain(&mut store::open(database)?, domain)
}

pub fn attach_domain(
    database: &Path,
    repository: &RepositoryId,
    domain: &DomainId,
    before: Option<&DomainId>,
) -> Result<bool> {
    store::attach_domain(&mut store::open(database)?, repository, domain, before)
}

pub fn detach_domain(
    database: &Path,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<bool> {
    store::detach_domain(&mut store::open(database)?, repository, domain)
}

pub fn delete_domain(database: &Path, domain: &DomainId) -> Result<bool> {
    store::delete_domain(&mut store::open(database)?, domain)
}

pub fn domains(database: &Path, repository: &RepositoryId, all: bool) -> Result<Vec<DomainId>> {
    let connection = store::open(database)?;
    if all {
        store::domains(&connection)
    } else {
        store::attached_domains(&connection, repository)
    }
}

pub fn attached_domains(database: &Path, repository: &RepositoryId) -> Result<Vec<DomainId>> {
    store::attached_domains(&store::open(database)?, repository)
}

#[must_use]
pub fn format_domains(domains: &[DomainId]) -> String {
    if domains.is_empty() {
        return "No domains found.\n".to_owned();
    }
    domains.iter().map(|domain| format!("{domain}\n")).collect()
}

#[must_use]
pub fn format_scope_show(scope: &ResolvedScope, domains: &[DomainId]) -> String {
    let mut output = format!(
        "active_scope: {}\nrepository_id: {}\nsource: {}\nattached_domains:\n",
        scope.scope(),
        scope.repository(),
        scope.source().label()
    );
    for domain in domains {
        output.push_str(&format!("- {domain}\n"));
    }
    output
}

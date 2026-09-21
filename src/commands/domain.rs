use std::path::Path;

use anyhow::Result;
use memocap::{cli, scope::RepositoryId};

use crate::DomainCommand;

pub(crate) fn run(
    database: &Path,
    repository: &RepositoryId,
    command: DomainCommand,
) -> Result<()> {
    match command {
        DomainCommand::Create { domain } => {
            if cli::create_domain(database, &domain)? {
                println!("created domain {domain}");
            } else {
                println!("domain already exists {domain}");
            }
        }
        DomainCommand::Attach { domain, before } => {
            if cli::attach_domain(database, repository, &domain, before.as_ref())? {
                println!("attached domain {domain}");
            } else {
                println!("domain already attached {domain}");
            }
        }
        DomainCommand::Detach { domain } => {
            if cli::detach_domain(database, repository, &domain)? {
                println!("detached domain {domain}");
            } else {
                println!("domain not attached {domain}");
            }
        }
        DomainCommand::List { all } => {
            print!(
                "{}",
                cli::format_domains(&cli::domains(database, repository, all)?)
            );
        }
        DomainCommand::Delete { domain } => {
            if cli::delete_domain(database, &domain)? {
                println!("deleted domain {domain}");
            } else {
                println!("domain not found {domain}");
            }
        }
    }
    Ok(())
}

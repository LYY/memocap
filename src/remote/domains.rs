use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::scope::{DomainId, RepositoryId};

use super::{decode, into_anyhow, post};

#[derive(Serialize)]
struct DomainBody<'a> {
    repository: &'a str,
    domain: &'a str,
    before: Option<&'a str>,
}

#[derive(Serialize)]
struct DomainsBody<'a> {
    repository: &'a str,
    all: bool,
}

#[derive(Deserialize)]
struct ChangedReply {
    changed: bool,
}

#[derive(Deserialize)]
struct DomainsReply {
    domains: Vec<String>,
}

pub fn create_domain(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<bool> {
    change(
        address,
        token,
        "/v1/domains/create",
        repository,
        domain,
        None,
    )
}

pub fn attach_domain(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    domain: &DomainId,
    before: Option<&DomainId>,
) -> Result<bool> {
    change(
        address,
        token,
        "/v1/domains/attach",
        repository,
        domain,
        before,
    )
}

pub fn detach_domain(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<bool> {
    change(
        address,
        token,
        "/v1/domains/detach",
        repository,
        domain,
        None,
    )
}

pub fn delete_domain(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<bool> {
    change(
        address,
        token,
        "/v1/domains/delete",
        repository,
        domain,
        None,
    )
}

pub fn domains(
    address: &str,
    token: &str,
    repository: &RepositoryId,
    all: bool,
) -> Result<Vec<DomainId>> {
    let body = DomainsBody {
        repository: repository.as_str(),
        all,
    };
    let reply = decode::<DomainsReply>(
        post(address, token, "/v1/domains/list", &body).map_err(into_anyhow)?,
        "domains reply",
    )?;
    reply
        .domains
        .into_iter()
        .map(|domain| {
            domain
                .parse()
                .map_err(|_| anyhow::anyhow!("domains reply contains invalid domain"))
        })
        .collect()
}

fn change(
    address: &str,
    token: &str,
    path: &str,
    repository: &RepositoryId,
    domain: &DomainId,
    before: Option<&DomainId>,
) -> Result<bool> {
    let body = DomainBody {
        repository: repository.as_str(),
        domain: domain.as_str(),
        before: before.map(DomainId::as_str),
    };
    let response = post(address, token, path, &body).map_err(into_anyhow)?;
    Ok(decode::<ChangedReply>(response, "domain reply")?.changed)
}

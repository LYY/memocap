use serde::Deserialize;

use crate::scope::{DomainId, RepositoryId};

use super::{repository, ParseError};

pub enum Domain {
    Create {
        domain: DomainId,
    },
    List {
        repository: RepositoryId,
        all: bool,
    },
    Attach {
        repository: RepositoryId,
        domain: DomainId,
        before: Option<DomainId>,
    },
    Detach {
        repository: RepositoryId,
        domain: DomainId,
    },
    Delete {
        domain: DomainId,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DomainIn {
    repository: String,
    domain: String,
    #[serde(default)]
    before: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DomainsIn {
    repository: String,
    all: bool,
}

pub fn create(body: &str) -> Result<Domain, ParseError> {
    let input = input(body)?;
    Ok(Domain::Create {
        domain: input.domain,
    })
}

pub fn list(body: &str) -> Result<Domain, ParseError> {
    let input = serde_json::from_str::<DomainsIn>(body).map_err(|_| ParseError::Invalid)?;
    Ok(Domain::List {
        repository: repository(&input.repository)?,
        all: input.all,
    })
}

pub fn attach(body: &str) -> Result<Domain, ParseError> {
    let input = input(body)?;
    Ok(Domain::Attach {
        repository: input.repository,
        domain: input.domain,
        before: input.before,
    })
}

pub fn detach(body: &str) -> Result<Domain, ParseError> {
    let input = input(body)?;
    Ok(Domain::Detach {
        repository: input.repository,
        domain: input.domain,
    })
}

pub fn delete(body: &str) -> Result<Domain, ParseError> {
    Ok(Domain::Delete {
        domain: input(body)?.domain,
    })
}

struct ParsedDomain {
    repository: RepositoryId,
    domain: DomainId,
    before: Option<DomainId>,
}

fn input(body: &str) -> Result<ParsedDomain, ParseError> {
    let input = serde_json::from_str::<DomainIn>(body).map_err(|_| ParseError::Invalid)?;
    Ok(ParsedDomain {
        repository: repository(&input.repository)?,
        domain: input.domain.parse().map_err(|_| ParseError::Invalid)?,
        before: input
            .before
            .map(|domain| domain.parse())
            .transpose()
            .map_err(|_| ParseError::Invalid)?,
    })
}

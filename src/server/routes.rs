use rusqlite::Connection;

use crate::{
    scope::{DomainId, PlacementId, RepositoryId},
    store::{self, RememberOptions, VisibleSource},
};

use super::{error, json, request::Request, Outgoing};

pub fn execute(connection: &mut Connection, request: Request) -> Outgoing {
    match request {
        Request::Remember(request) => remember(connection, request),
        Request::Recall(request) => recall(connection, request),
        Request::List(request) => list(connection, request),
        Request::Forget(request) => forget(connection, request),
        Request::Domain(request) => domain(connection, request),
        Request::Transfer(request) => transfer(connection, request),
        Request::OperationStatus(request) => operation_status(connection, request),
        Request::Status { repository } => status(connection, &repository),
    }
}

fn remember(connection: &Connection, request: super::request::Remember) -> Outgoing {
    if validate_placement(connection, &request.repository, &request.placement).is_err() {
        return error(400, "invalid_request");
    }
    match store::remember_at(
        connection,
        &request.placement,
        &request.content,
        &request.kind,
        &request.tags,
        RememberOptions {
            topic_key: request.topic_key.as_deref(),
            force: request.force,
            overwrite_id: request.overwrite_id,
        },
    ) {
        Ok(id) => json(200, serde_json::json!({"id": id})),
        Err(error_value) => {
            if let Some(similar) = error_value.downcast_ref::<store::SimilarMemories>() {
                json(
                    409,
                    serde_json::json!({"error": "similar_memories", "candidates": similar.candidates}),
                )
            } else {
                error(400, "invalid_request")
            }
        }
    }
}

fn recall(connection: &Connection, request: super::request::Recall) -> Outgoing {
    let sources = match sources(connection, &request.repository, request.placement.as_ref()) {
        Ok(sources) => sources,
        Err(_) => return error(400, "invalid_request"),
    };
    match store::recall_visible(
        connection,
        &sources,
        &request.query,
        request.limit,
        request.kind.as_deref(),
        request.max_chars,
    ) {
        Ok(memories) => json(200, serde_json::json!({"memories": memories})),
        Err(_) => error(400, "invalid_request"),
    }
}

fn list(connection: &Connection, request: super::request::List) -> Outgoing {
    let sources = match sources(connection, &request.repository, request.placement.as_ref()) {
        Ok(sources) => sources,
        Err(_) => return error(400, "invalid_request"),
    };
    match store::list_inventory(connection, &sources, request.limit) {
        Ok(memories) => json(200, serde_json::json!({"memories": memories})),
        Err(_) => error(400, "invalid_request"),
    }
}

fn forget(connection: &Connection, request: super::request::Forget) -> Outgoing {
    if validate_placement(connection, &request.repository, &request.placement).is_err() {
        return error(400, "invalid_request");
    }
    match store::forget_at(connection, &request.placement, request.id) {
        Ok(deleted) => json(200, serde_json::json!({"deleted": deleted})),
        Err(_) => error(400, "invalid_request"),
    }
}

fn domain(connection: &mut Connection, request: super::request::Domain) -> Outgoing {
    let result = match request {
        super::request::Domain::Create { domain } => store::create_domain(connection, &domain)
            .map(|changed| serde_json::json!({"changed": changed})),
        super::request::Domain::List { repository, all } => {
            let domains = if all {
                store::domains(connection)
            } else {
                store::attached_domains(connection, &repository)
            };
            domains.map(|domains| serde_json::json!({"domains": domain_values(&domains)}))
        }
        super::request::Domain::Attach {
            repository,
            domain,
            before,
        } => store::attach_domain(connection, &repository, &domain, before.as_ref())
            .map(|changed| serde_json::json!({"changed": changed})),
        super::request::Domain::Detach { repository, domain } => {
            store::detach_domain(connection, &repository, &domain)
                .map(|changed| serde_json::json!({"changed": changed}))
        }
        super::request::Domain::Delete { domain } => store::delete_domain(connection, &domain)
            .map(|changed| serde_json::json!({"changed": changed})),
    };
    match result {
        Ok(body) => json(200, body),
        Err(_) => error(400, "invalid_request"),
    }
}

fn status(connection: &Connection, repository: &RepositoryId) -> Outgoing {
    let domains = match store::attached_domains(connection, repository) {
        Ok(domains) => domains,
        Err(_) => return error(500, "internal"),
    };
    let sources = match store::visible_sources(connection, repository) {
        Ok(sources) => sources,
        Err(_) => return error(500, "internal"),
    };
    match store::visible_status(connection, &sources) {
        Ok(status) => json(
            200,
            serde_json::json!({"domains": domain_values(&domains), "status": status}),
        ),
        Err(_) => error(500, "internal"),
    }
}

fn sources(
    connection: &Connection,
    repository: &RepositoryId,
    placement: Option<&PlacementId>,
) -> anyhow::Result<Vec<VisibleSource>> {
    match placement {
        Some(placement) => {
            validate_placement(connection, repository, placement)?;
            Ok(vec![store::single_visible_source(placement.clone())])
        }
        None => store::visible_sources(connection, repository),
    }
}

fn validate_placement(
    connection: &Connection,
    repository: &RepositoryId,
    placement: &PlacementId,
) -> anyhow::Result<()> {
    match placement {
        PlacementId::Repository(value) if value != repository => {
            anyhow::bail!("repository placement must match request repository")
        }
        PlacementId::Repository(_) | PlacementId::Universal => Ok(()),
        PlacementId::Domain(domain) => validate_domain(connection, repository, domain),
    }
}

fn validate_domain(
    connection: &Connection,
    repository: &RepositoryId,
    domain: &DomainId,
) -> anyhow::Result<()> {
    if !store::domains(connection)?.contains(domain) {
        anyhow::bail!("domain does not exist")
    }
    if !store::attached_domains(connection, repository)?.contains(domain) {
        anyhow::bail!("domain is not attached")
    }
    Ok(())
}

fn domain_values(domains: &[DomainId]) -> Vec<String> {
    domains.iter().map(ToString::to_string).collect()
}

fn transfer(connection: &mut Connection, transfer: super::request::Transfer) -> Outgoing {
    let request = transfer.request;
    match store::replay_copy_move(connection, &request) {
        Ok(Some(result)) => return transfer_result(result),
        Ok(None) => {}
        Err(_) => return error(409, "conflict"),
    }
    if validate_placement(connection, request.repository(), request.from()).is_err()
        || validate_placement(connection, request.repository(), request.to()).is_err()
    {
        return error(400, "invalid_request");
    }
    match store::copy_move(connection, request) {
        Ok(result) => transfer_result(result),
        Err(error_value) if error_value.to_string().contains("operation ID conflict") => {
            error(409, "conflict")
        }
        Err(_) => error(400, "invalid_request"),
    }
}

fn operation_status(connection: &Connection, request: super::request::OperationStatus) -> Outgoing {
    match store::operation_status(
        connection,
        &request.repository,
        &request.operation_id,
        &request.request_fingerprint,
    ) {
        Ok(Some(result)) => json(
            200,
            serde_json::json!({"outcome": "committed", "result": transfer_body(&result)}),
        ),
        Ok(None) => json(200, serde_json::json!({"outcome": "not_found"})),
        Err(error_value) if error_value.to_string().contains("operation ID conflict") => {
            error(409, "conflict")
        }
        Err(_) => error(500, "internal"),
    }
}

fn transfer_result(result: store::CopyMoveResult) -> Outgoing {
    json(200, serde_json::json!({"result": transfer_body(&result)}))
}

fn transfer_body(result: &store::CopyMoveResult) -> serde_json::Value {
    serde_json::json!({
        "action": result.action,
        "memory_id": result.memory_id,
        "from": result.from.to_string(),
        "to": result.to.to_string(),
        "operation_id": result.operation_id.to_string(),
    })
}

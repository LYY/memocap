use super::{error, json, request::Recall, Outgoing};
use crate::{
    activity::ActivityBackend,
    operation,
    receipt::{Receipt, Target},
    store,
};
use std::path::Path;

pub(super) fn execute(database: &Path, query: Recall) -> Outgoing {
    let receipt = Receipt::new("recall");
    let operation_id = match receipt.operation_id.parse() {
        Ok(id) => id,
        Err(_) => return error(500, "internal"),
    };
    let request = operation::Request {
        operation_id,
        targets: vec![Target {
            repository_id: query.repository,
            canonical_path: None,
            identity_source: "explicit".into(),
            placements: vec![],
            descriptor: None,
            observed_at: None,
        }],
        caller: operation::Caller::default(),
        command: operation::Command::Recall {
            query: query.query,
            match_mode: store::MatchMode::All,
            limit: query.limit,
            kind: query.kind,
            max_chars: query.max_chars,
            placement: query.placement,
        },
    };
    let receipt = operation::execute(database, &request, ActivityBackend::Remote);
    if !receipt.succeeded() {
        return error(400, "invalid_request");
    }
    let memories = receipt
        .results
        .into_iter()
        .map(|entry| store::InventoryMemory {
            memory: entry.memory,
            source_order: entry.source_order,
            visibility: store::Visibility::Visible,
        })
        .collect::<Vec<_>>();
    json(
        200,
        serde_json::json!({"memories": memories, "repository_context":receipt.repository_context, "activity_status": receipt.activity_status, "warning": receipt.warning}),
    )
}

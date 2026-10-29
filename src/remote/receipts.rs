use crate::{
    operation::{Command, Request},
    receipt::{Receipt, Status},
    store,
};
use anyhow::{bail, ensure, Result};
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct Capabilities {
    format_version: u8,
    package_version: String,
    capabilities: Vec<String>,
}

pub fn execute_receipt(address: &str, token: &str, request: &Request) -> Result<Receipt> {
    verify_version(address, token)?;
    match send(address, token, "/v1/receipt", request) {
        Ok(response) => match serde_json::from_str::<Receipt>(&response) {
            Ok(receipt)
                if receipt.format_version == 1
                    && receipt.backend == "remote"
                    && receipt.operation == request.command.name() =>
            {
                Ok(receipt)
            }
            _ if request.command.is_write() => recover(address, token, request),
            _ => bail!("remote returned a malformed or incompatible receipt"),
        },
        Err(super::RequestError::Http { status: 400, body }) => serde_json::from_str(&body)
            .map_err(|_| anyhow::anyhow!("remote rejected receipt request")),
        Err(error) if error.is_ambiguous() && request.command.is_write() => {
            recover(address, token, request)
        }
        Err(_) => bail!("remote receipt request failed"),
    }
}

pub(super) fn verify_version(address: &str, token: &str) -> Result<()> {
    let capabilities =
        send(address, token, "/v1/capabilities", &serde_json::json!({})).map_err(|_| {
            anyhow::anyhow!("remote server does not provide authenticated receipt capabilities")
        })?;
    let capabilities: Capabilities = serde_json::from_str(&capabilities)?;
    ensure!(
        capabilities.package_version == env!("CARGO_PKG_VERSION"),
        "remote package version {} differs from client {}; install the same package version before continuing",
        capabilities.package_version,
        env!("CARGO_PKG_VERSION")
    );
    ensure!(
        capabilities.format_version == 1
            && crate::inspection::CAPABILITIES
                .iter()
                .all(|required| capabilities
                    .capabilities
                    .iter()
                    .any(|available| available == required)),
        "remote server lacks required receipt, match, inventory or activity capability"
    );
    Ok(())
}

fn recover(address: &str, token: &str, request: &Request) -> Result<Receipt> {
    let mut receipt = Receipt::new(request.command.name());
    receipt.operation_id = request.operation_id.to_string();
    receipt.targets = request.targets.clone();
    receipt.caller = request.caller.clone();
    receipt.backend = "remote".into();
    receipt.origin = "server".into();
    receipt.fail(
        "outcome_unknown",
        "remote write outcome unknown; do not replay the write".into(),
    );
    receipt.status = Status::OutcomeUnknown;
    if let Command::Transfer {
        action,
        id,
        from,
        to,
        idempotency_key,
        note,
    } = &request.command
    {
        let repository = request
            .targets
            .first()
            .ok_or_else(|| anyhow::anyhow!("repository target is required"))?
            .repository_id
            .clone();
        let transfer = store::CopyMoveRequest::prepare(
            repository,
            store::CopyMoveInput {
                action: *action,
                memory_id: *id,
                from: from.clone(),
                to: to.clone(),
                operation_id: idempotency_key.clone(),
                applicability_note: note.clone(),
            },
        )?;
        let handle = super::RecoveryHandle::from_request(&transfer)?;
        receipt.recovery = Some(handle.to_string());
        receipt.operation_id = transfer.operation_id().to_string();
        if let Ok(super::OperationStatus::Committed(committed)) =
            super::operation_status(address, token, &handle)
        {
            receipt.status = match action {
                store::CopyMoveAction::Copy => Status::Inserted,
                store::CopyMoveAction::Move => Status::Updated,
            };
            receipt.error = None;
            receipt.returned_ids = vec![committed.memory_id];
            receipt.searched_placements = vec![from.to_string(), to.to_string()];
            receipt.warning = Some("core commit recovered; activity status unavailable".into());
        }
    }
    Ok(receipt)
}

fn send<T: serde::Serialize>(
    address: &str,
    token: &str,
    path: &str,
    body: &T,
) -> std::result::Result<String, super::RequestError> {
    let address = address.trim().trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .redirects(0)
        .build();
    match agent
        .post(&format!("{address}{path}"))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(body)
    {
        Ok(response) => response.into_string().map_err(super::RequestError::Read),
        Err(ureq::Error::Status(status, response)) => Err(super::RequestError::Http {
            status,
            body: response.into_string().unwrap_or_default(),
        }),
        Err(error) => Err(super::RequestError::Transport(Box::new(error))),
    }
}

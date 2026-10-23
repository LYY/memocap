use crate::{receipt::Receipt, remote::RecoveryHandle, store};
use anyhow::{ensure, Result};
use std::path::Path;

pub(super) fn inspect(database: &Path, recovery: &str, receipt: &mut Receipt) -> Result<()> {
    let handle: RecoveryHandle = recovery.parse()?;
    ensure!(
        receipt
            .targets
            .first()
            .is_some_and(|target| &target.repository_id == handle.repository()),
        "recovery repository must match the target"
    );
    receipt.operation_id = handle.operation_id().to_string();
    receipt.recovery = Some(recovery.into());
    let committed = if database.try_exists()? {
        let connection = store::open_readonly(database)?;
        store::operation_status(
            &connection,
            handle.repository(),
            handle.operation_id(),
            handle.request_fingerprint(),
        )?
    } else {
        None
    };
    receipt.outcome = Some(
        if committed.is_some() {
            "committed"
        } else {
            "not_found"
        }
        .into(),
    );
    if let Some(committed) = committed {
        receipt.returned_ids = vec![committed.memory_id];
        receipt.searched_placements = vec![committed.from.to_string(), committed.to.to_string()];
    } else {
        receipt.warning =
            Some("not_found does not prove replay is safe; outcome may remain unknown".into());
    }
    Ok(())
}

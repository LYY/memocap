#[path = "support/release_workflow.rs"]
mod release_workflow_contract;

use release_workflow_contract::{release_contract, RELEASE_WORKFLOW};

#[test]
fn actual_release_workflow_enforces_release_and_registry_contract() {
    assert_eq!(release_contract(RELEASE_WORKFLOW), Ok(()));
}

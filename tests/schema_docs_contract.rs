use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use serde::Deserialize;
use serde_json::{json, Value};

const SCHEMA_DOC_PATH: &str = "docs/SCHEMA-VERSIONING.md";
const DEPLOYMENT_DOC_PATH: &str = "docs/DEPLOYMENT.md";
const SCHEMA_DOC: &str = "```json\n";

#[derive(Debug, Deserialize)]
struct SchemaContract {
    contract: String,
    schema_version: String,
    package_version: PackageVersion,
    commands: Commands,
    states: Vec<State>,
    reset_exception: ResetException,
}

#[derive(Debug, Deserialize)]
struct PackageVersion {
    example: String,
    manifest_unchanged: bool,
}

#[derive(Debug, Deserialize)]
struct Commands {
    open: Vec<String>,
    reset: String,
}

#[derive(Debug, Deserialize)]
struct State {
    id: String,
    action: String,
    data_outcome: String,
    notice: String,
}

#[derive(Debug, Deserialize)]
struct ResetException {
    sole_approved_no_confirmation_bulk_delete_exception: bool,
    recognition: String,
    transaction: String,
    backup: String,
    notice: String,
}

fn read_repo_file(path: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

fn policy_json(markdown: &str) -> Option<Value> {
    let normalized_markdown = markdown.replace("\r\n", "\n");
    let (_, fenced) = normalized_markdown.split_once(SCHEMA_DOC)?;
    let json_block = fenced.split_once("\n```")?.0;
    serde_json::from_str(json_block).ok()
}

fn parse_contract(markdown: &str) -> Option<SchemaContract> {
    serde_json::from_value(policy_json(markdown)?).ok()
}

fn product_and_schema_identities_are_valid(contract: &SchemaContract, package: &Value) -> bool {
    contract.schema_version == "1.0"
        && package["version"].as_str() == Some(contract.package_version.example.as_str())
}

fn states_by_id(contract: &SchemaContract) -> BTreeMap<&str, &State> {
    contract
        .states
        .iter()
        .map(|state| (state.id.as_str(), state))
        .collect()
}

fn contract_is_valid(markdown: &str) -> bool {
    let Some(contract) = parse_contract(markdown) else {
        return false;
    };
    if contract.contract != "memocap-schema-versioning"
        || contract.schema_version != "1.0"
        || contract.package_version.example != "0.0.6"
        || contract.package_version.manifest_unchanged
        || contract.commands.open
            != [
                "memocap remember <CONTENT>",
                "memocap recall <QUERY>",
                "memocap list",
                "memocap status",
            ]
        || contract.commands.reset
            != "automatic only when opening an exact recognized pre-versioned database; no standalone reset command"
    {
        return false;
    }

    let state_ids: Vec<&str> = contract
        .states
        .iter()
        .map(|state| state.id.as_str())
        .collect();
    let unique_state_ids: BTreeSet<&str> = state_ids.iter().copied().collect();
    if state_ids.len() != 7
        || unique_state_ids.len() != state_ids.len()
        || ![
            "fresh",
            "exact_pre_versioned",
            "unknown_pre_versioned",
            "exact_current",
            "lower_minor",
            "higher_minor",
            "different_major",
        ]
        .iter()
        .all(|id| unique_state_ids.contains(id))
    {
        return false;
    }

    let states = states_by_id(&contract);
    let Some(fresh) = states.get("fresh") else {
        return false;
    };
    let Some(exact_pre_versioned) = states.get("exact_pre_versioned") else {
        return false;
    };
    let Some(unknown_pre_versioned) = states.get("unknown_pre_versioned") else {
        return false;
    };
    let Some(exact_current) = states.get("exact_current") else {
        return false;
    };
    let Some(lower_minor) = states.get("lower_minor") else {
        return false;
    };
    let Some(higher_minor) = states.get("higher_minor") else {
        return false;
    };
    let Some(different_major) = states.get("different_major") else {
        return false;
    };

    fresh.action == "create current schema 1.0"
        && fresh.data_outcome == "database starts empty"
        && fresh.notice == "none"
        && exact_pre_versioned.action == "reset transactionally to current schema 1.0"
        && exact_pre_versioned.data_outcome
            == "all pre-versioned memory rows are deleted; no backup is made"
        && exact_pre_versioned.notice
            == "memocap: reset recognized pre-versioned database to schema 1.0"
        && unknown_pre_versioned.action == "refuse without mutation"
        && unknown_pre_versioned.data_outcome == "existing database remains unchanged"
        && unknown_pre_versioned.notice == "error"
        && exact_current.action == "open"
        && exact_current.data_outcome == "rows remain unchanged"
        && exact_current.notice == "none"
        && lower_minor.action == "run registered lower-minor migrations transactionally"
        && lower_minor.data_outcome == "registered migrations determine row changes"
        && lower_minor.notice == "none unless migration fails"
        && higher_minor.action == "refuse without mutation"
        && higher_minor.data_outcome == "rows and schema remain unchanged"
        && higher_minor.notice == "error"
        && different_major.action == "refuse without mutation"
        && different_major.data_outcome == "rows and schema remain unchanged"
        && different_major.notice == "error"
        && contract.reset_exception.sole_approved_no_confirmation_bulk_delete_exception
        && contract.reset_exception.recognition
            == "exact pre-versioned schema fingerprint; SQLite internal names are excluded only when their names literally match sqlite_*"
        && contract.reset_exception.transaction
            == "immediate transaction; rollback on failure"
        && contract.reset_exception.backup == "none"
        && contract.reset_exception.notice
            == "memocap: reset recognized pre-versioned database to schema 1.0"
}

fn documentation_links_are_valid() -> bool {
    let english = read_repo_file("README.md");
    let chinese = read_repo_file("README-CN.md");
    let rebuild = read_repo_file("docs/REBUILD.md");
    english.matches("docs/SCHEMA-VERSIONING.md").count() == 1
        && chinese.matches("docs/SCHEMA-VERSIONING.md").count() == 1
        && rebuild.matches("SCHEMA-VERSIONING.md").count() == 1
}

fn package_includes_document_once(package: &Value, path: &str) -> bool {
    package["files"]
        .as_array()
        .is_some_and(|files| files.iter().filter(|file| file == &&json!(path)).count() == 1)
}

fn package_includes_schema_doc_once() -> bool {
    let package: Value = serde_json::from_str(&read_repo_file("package.json")).unwrap();
    package_includes_document_once(&package, SCHEMA_DOC_PATH)
}

fn package_includes_deployment_doc_once() -> bool {
    let package: Value = serde_json::from_str(&read_repo_file("package.json")).unwrap();
    package_includes_document_once(&package, DEPLOYMENT_DOC_PATH)
}

#[test]
fn schema_contract_has_machine_parseable_policy_and_required_links() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let package: Value = serde_json::from_str(&read_repo_file("package.json")).unwrap();
    let contract = parse_contract(&schema_doc).expect("schema policy JSON must parse");

    assert!(contract_is_valid(&schema_doc));
    assert!(product_and_schema_identities_are_valid(&contract, &package));
    assert!(documentation_links_are_valid());
    assert!(package_includes_schema_doc_once());
    assert!(package_includes_deployment_doc_once());

    let changelog = read_repo_file("CHANGELOG.md");
    assert!(changelog.contains("data loss"));
    assert!(changelog.contains("no backup"));
}

#[test]
fn schema_contract_accepts_windows_line_endings() {
    let windows_schema_doc = read_repo_file(SCHEMA_DOC_PATH)
        .replace("\r\n", "\n")
        .replace('\n', "\r\n");

    assert!(contract_is_valid(&windows_schema_doc));
}

#[test]
fn schema_contract_rejects_product_or_schema_identity_drift() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let package: Value = serde_json::from_str(&read_repo_file("package.json")).unwrap();
    let mut product_drift = policy_json(&schema_doc).expect("schema policy JSON must parse");
    product_drift["package_version"]["example"] = json!("0.0.5");
    let product_drift_contract = parse_contract(&format!("```json\n{product_drift}\n```"))
        .expect("mutated schema policy JSON must parse");

    assert!(!product_and_schema_identities_are_valid(
        &product_drift_contract,
        &package
    ));

    let mut schema_drift = policy_json(&schema_doc).expect("schema policy JSON must parse");
    schema_drift["schema_version"] = json!("0.0.6");
    let schema_drift_contract = parse_contract(&format!("```json\n{schema_drift}\n```"))
        .expect("mutated schema policy JSON must parse");

    assert!(!product_and_schema_identities_are_valid(
        &schema_drift_contract,
        &package
    ));
}

#[test]
fn package_contract_rejects_missing_or_duplicate_deployment_doc() {
    let package: Value = serde_json::from_str(&read_repo_file("package.json")).unwrap();
    let files = package["files"]
        .as_array()
        .expect("package files must be an array")
        .clone();

    let missing = json!({"files": files.iter().filter(|file| *file != &json!(DEPLOYMENT_DOC_PATH)).collect::<Vec<_>>()});
    assert!(!package_includes_document_once(
        &missing,
        DEPLOYMENT_DOC_PATH
    ));

    let mut duplicate_files = files;
    duplicate_files.push(json!(DEPLOYMENT_DOC_PATH));
    let duplicate = json!({"files": duplicate_files});
    assert!(!package_includes_document_once(
        &duplicate,
        DEPLOYMENT_DOC_PATH
    ));
}

#[test]
fn schema_contract_rejects_malformed_matrix_mutation() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let mut policy = policy_json(&schema_doc).expect("schema policy JSON must parse");
    policy["states"] = json!([]);

    assert!(!contract_is_valid(&policy.to_string()));
}

#[test]
fn schema_contract_rejects_duplicate_state_id_mutation() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let mut policy = policy_json(&schema_doc).expect("schema policy JSON must parse");
    let mut states = policy["states"]
        .as_array()
        .expect("schema policy states must be an array")
        .clone();
    let duplicate_fresh = states
        .iter()
        .find(|state| state["id"] == "fresh")
        .expect("schema policy must contain fresh")
        .clone();
    states.push(duplicate_fresh);
    policy["states"] = Value::Array(states);

    let mutated_markdown = format!("```json\n{}\n```", policy);
    assert!(!contract_is_valid(&mutated_markdown));
}

#[test]
fn schema_contract_rejects_misleading_reset_success_mutation() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let mut policy = policy_json(&schema_doc).expect("schema policy JSON must parse");
    policy["reset_exception"]["notice"] = json!("reset completed successfully; no data loss");

    assert!(!contract_is_valid(&policy.to_string()));
}

#[test]
fn schema_contract_rejects_backup_policy_mutation() {
    let schema_doc = read_repo_file(SCHEMA_DOC_PATH);
    let mut policy = policy_json(&schema_doc).expect("schema policy JSON must parse");
    policy["reset_exception"]["backup"] = json!("automatic backup");

    assert!(!contract_is_valid(&policy.to_string()));
}

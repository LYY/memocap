use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct Package {
    files: Vec<String>,
}

#[test]
fn npm_payload_includes_existing_schema_and_deployment_guides_once() {
    let package: Package = serde_json::from_str(include_str!("../package.json")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));

    for document in ["docs/SCHEMA-VERSIONING.md", "docs/DEPLOYMENT.md"] {
        assert_eq!(
            package
                .files
                .iter()
                .filter(|file| *file == document)
                .count(),
            1,
            "npm files must include {document} once"
        );
        assert!(root.join(document).is_file(), "missing payload: {document}");
    }
}

use serde_json::{json, Value};

#[test]
fn npm_package_has_independent_opencode_identity() {
    let package: Value = serde_json::from_str(include_str!("../package.json")).unwrap();

    assert_eq!(package["name"], "@lyy-gh/memocap");
    assert_eq!(package["version"], "0.0.1");
    assert_eq!(
        package["description"],
        "Local-first SQLite memory for OpenCode"
    );
    assert_eq!(package["repository"]["type"], "git");
    assert_eq!(
        package["repository"]["url"],
        "https://github.com/LYY/memocap.git"
    );
    assert!(package.get("pi").is_none());
    assert!(package.get("keywords").is_none());
    assert!(!package.to_string().contains("pi-package"));
    assert_eq!(package["bin"], json!({ "memocap": "bin/cli.cjs" }));
    assert_eq!(package["main"], "./plugin/index.js");
    assert_eq!(package["exports"], json!({ ".": "./plugin/index.js" }));
    assert_eq!(
        package["files"],
        json!(["bin", "plugin", "skills", "README.md", "README-CN.md"])
    );
}

#[test]
fn cargo_package_has_independent_opencode_identity() {
    assert_eq!(env!("CARGO_PKG_NAME"), "memocap");
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.0.1");
    assert_eq!(
        env!("CARGO_PKG_DESCRIPTION"),
        "Local-first SQLite memory CLI for OpenCode"
    );
    assert_eq!(
        env!("CARGO_PKG_REPOSITORY"),
        "https://github.com/LYY/memocap"
    );
}

use serde_json::Value;
use std::{path::PathBuf, process::Command};

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub database: PathBuf,
    pub a: PathBuf,
    pub b: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        Self {
            database: root.path().join("core.db"),
            root,
            a,
            b,
        }
    }

    pub fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
        command
            .args(args)
            .current_dir(&self.a)
            .env("MEMOCAP_DB", &self.database)
            .env("MEMOCAP_HOME", self.root.path())
            .env_remove("MEMOCAP_ADDR")
            .env_remove("MEMOCAP_URL")
            .env_remove("MEMOCAP_ADDRESS")
            .env_remove("MEMOCAP_TOKEN");
        command
    }

    pub fn json(&self, args: &[&str], success: bool) -> Value {
        let output = self.command(args).output().unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)))
    }
}

use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub database: std::path::PathBuf,
    pub connection: rusqlite::Connection,
}

impl Fixture {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("db");
        let connection = memocap::store::open(&database).unwrap();
        for body in [
            "original survivor",
            "first source",
            "reference source",
            "fourth record",
        ] {
            connection.execute("INSERT INTO memories(content,created_at,updated_at) VALUES(?1,'created','updated')", [body]).unwrap();
        }
        Self {
            directory,
            database,
            connection,
        }
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
        command
            .current_dir(self.directory.path())
            .env("MEMOCAP_DB", &self.database)
            .env("MEMOCAP_HOME", self.directory.path())
            .env("HOME", self.directory.path())
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env("XDG_DATA_HOME", self.directory.path().join("data"))
            .env("XDG_CACHE_HOME", self.directory.path().join("cache"));
        for variable in [
            "MEMOCAP_ADDR",
            "MEMOCAP_URL",
            "MEMOCAP_ADDRESS",
            "MEMOCAP_TOKEN",
        ] {
            command.env_remove(variable);
        }
        command
    }

    pub fn invoke(&self, args: &[&str], input: &str) -> Value {
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let receipt: Value =
            serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"));
        assert_eq!(
            output.status.success(),
            receipt["error"].is_null(),
            "{receipt}"
        );
        receipt
    }

    pub fn snapshot(&self, id: i64) -> Value {
        self.invoke(
            &["organize", "read", "--json"],
            &json!({"keys":[{"id":id,"placement":"universal"}]}).to_string(),
        )["organization"]["records"][0]["snapshot"]
            .clone()
    }

    pub fn maintain(&self, group: Value, dependencies: Vec<Value>) -> Value {
        self.invoke(
            &[
                "organize",
                "maintain",
                "--json",
                "--caller-json",
                r#"{"actor":"plugin","session_id":"maintenance-native","message_id":"message"}"#,
            ],
            &json!({"mode":"all","group":group,"dependencies":dependencies}).to_string(),
        )
    }

    pub fn history(&self, receipt: &Value) -> Value {
        self.invoke(
            &[
                "activity",
                "show",
                receipt["operation_id"].as_str().unwrap(),
                "--json",
            ],
            "",
        )["events"]
            .clone()
    }
}

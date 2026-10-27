#[derive(Debug, serde::Serialize)]
pub struct CliAttempt {
    pub args: Vec<String>,
    pub elapsed_us: u128,
    pub exit: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub spawn_error: Option<String>,
}

pub fn run(dir: &std::path::Path, address: &str, commands: &[&[&str]]) -> Vec<CliAttempt> {
    let mut attempts = Vec::new();
    for args in commands {
        let start = std::time::Instant::now();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_memocap"))
            .args(*args)
            .arg("--json")
            .current_dir(dir)
            .env("MEMOCAP_HOME", dir)
            .env("MEMOCAP_ADDR", address)
            .env("MEMOCAP_TOKEN", "receipt-test-token")
            .env("MEMOCAP_DB", dir.join("client-must-not-exist.db"))
            .output();
        let mut attempt = CliAttempt {
            args: args
                .iter()
                .copied()
                .chain(["--json"])
                .map(str::to_owned)
                .collect(),
            elapsed_us: start.elapsed().as_micros(),
            exit: None,
            success: false,
            stdout: String::new(),
            stderr: String::new(),
            spawn_error: None,
        };
        match output {
            Ok(output) => {
                attempt.exit = output.status.code();
                attempt.success = output.status.success();
                attempt.stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                attempt.stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            }
            Err(error) => attempt.spawn_error = Some(error.to_string()),
        }
        let success = attempt.success;
        attempts.push(attempt);
        if !success {
            break;
        }
    }
    attempts
}

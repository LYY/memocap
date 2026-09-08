use anyhow::Result;
use clap::{ArgGroup, Parser, Subcommand};

use memocap::scope;

mod commands;

#[derive(Parser)]
#[command(
    name = "memocap",
    version,
    about = "Local-first SQLite memory for OpenCode"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Store an explicit memory.
    Remember {
        content: String,
        #[arg(long, default_value = "context")]
        r#type: String,
        #[arg(long, default_value = "")]
        tags: String,
        /// Insert even if similar memories exist.
        #[arg(long)]
        force: bool,
        /// Overwrite an existing memory by id.
        #[arg(long)]
        id: Option<i64>,
        /// Store in the global memory scope.
        #[arg(long)]
        global: bool,
        /// Topic used to replace a global memory during repository recall.
        #[arg(long)]
        topic: Option<String>,
    },
    /// Search memory using SQLite full-text search.
    Recall {
        query: String,
        #[arg(long, default_value_t = memocap::store::DEFAULT_RECALL_LIMIT)]
        limit: usize,
        #[arg(long)]
        r#type: Option<String>,
        #[arg(long)]
        max_chars: Option<usize>,
        /// Search only global memories.
        #[arg(long)]
        global: bool,
    },
    /// Show newest memories.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Show only global memories.
        #[arg(long)]
        global: bool,
    },
    /// Delete one memory by ID.
    Forget {
        id: i64,
        /// Delete only from the global memory scope.
        #[arg(long)]
        global: bool,
    },
    /// Inspect or migrate local memory scopes.
    Scope {
        #[command(subcommand)]
        command: ScopeCommand,
    },
    /// Configure legacy compatibility files (unsupported).
    Install {
        /// Write legacy compatibility files under the user home (unsupported).
        #[arg(long)]
        global: bool,
    },
    /// Remove only memocap's legacy compatibility blocks (unsupported).
    Uninstall {
        #[arg(long)]
        global: bool,
    },
    /// Print legacy compatibility install and database status.
    Status {
        #[arg(long)]
        global: bool,
    },
    /// Serve the same SQLite over HTTP. Token required.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: String,
    },
    /// Open the interactive installer.
    Ui,
}

#[derive(Subcommand)]
pub(crate) enum ScopeCommand {
    /// Show the current opaque repository scope.
    Show,
    /// Move global or historical memories into the current repository scope.
    #[command(group = ArgGroup::new("migration_selector").required(true))]
    Migrate {
        #[arg(long)]
        from: scope::ScopeId,
        #[arg(long, group = "migration_selector")]
        id: Option<i64>,
        #[arg(long, group = "migration_selector")]
        all: bool,
        #[arg(long, conflicts_with = "yes")]
        dry_run: bool,
        #[arg(long, requires = "all", conflicts_with = "dry_run")]
        yes: bool,
    },
}

fn main() -> Result<()> {
    commands::run(Cli::parse().command.unwrap_or(Command::Ui))
}

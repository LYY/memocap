use anyhow::Result;
use clap::{Parser, Subcommand};

use memocap::{remote, scope};

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
        /// Store in an attached domain.
        #[arg(long, conflicts_with = "universal")]
        domain: Option<scope::DomainId>,
        /// Store in universal memory.
        #[arg(long)]
        universal: bool,
        /// Label memory with a topic.
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
        /// Search only an attached domain.
        #[arg(long, conflicts_with = "universal")]
        domain: Option<scope::DomainId>,
        /// Search only universal memory.
        #[arg(long)]
        universal: bool,
    },
    /// Show newest memories.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Show only an attached domain.
        #[arg(long, conflicts_with = "universal")]
        domain: Option<scope::DomainId>,
        /// Show only universal memory.
        #[arg(long)]
        universal: bool,
    },
    /// Delete one memory by ID.
    Forget {
        id: i64,
        /// Delete only from an attached domain.
        #[arg(long, conflicts_with = "universal")]
        domain: Option<scope::DomainId>,
        /// Delete only from universal memory.
        #[arg(long)]
        universal: bool,
    },
    /// Inspect local memory placement and domains.
    Scope {
        #[command(subcommand)]
        command: ScopeCommand,
    },
    /// Inspect a remote copy/move operation without replaying it.
    Operation {
        #[command(subcommand)]
        command: OperationCommand,
    },
    /// Print database and placement status.
    Status,
    /// Serve the same SQLite over HTTP. Token required.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: String,
    },
    /// Open the interactive menu.
    Ui,
}

#[derive(Subcommand)]
pub(crate) enum ScopeCommand {
    /// Show the current repository and its attached domains.
    Show,
    /// Copy one memory between exact local placements.
    Copy {
        #[arg(long)]
        id: i64,
        #[arg(long)]
        from: scope::PlacementId,
        #[arg(long)]
        to: scope::PlacementId,
        #[arg(long)]
        operation_id: Option<scope::OperationId>,
        #[arg(long)]
        note: Option<String>,
    },
    /// Move one memory between exact local placements.
    Move {
        #[arg(long)]
        id: i64,
        #[arg(long)]
        from: scope::PlacementId,
        #[arg(long)]
        to: scope::PlacementId,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        operation_id: Option<scope::OperationId>,
        #[arg(long)]
        note: Option<String>,
    },
    /// Manage the reusable domain registry and this repository's attachments.
    Domain {
        #[command(subcommand)]
        command: DomainCommand,
    },
}

#[derive(Subcommand)]
pub(crate) enum DomainCommand {
    /// Register a reusable domain ID.
    Create { domain: scope::DomainId },
    /// Attach a registered domain to the current repository.
    Attach {
        domain: scope::DomainId,
        /// Insert before an already attached domain.
        #[arg(long)]
        before: Option<scope::DomainId>,
    },
    /// Detach a domain from the current repository.
    Detach { domain: scope::DomainId },
    /// List current repository attachments, or every registered domain.
    List {
        /// List every registered domain instead of current repository attachments.
        #[arg(long)]
        all: bool,
    },
    /// Delete an unused domain from the registry.
    Delete { domain: scope::DomainId },
}

#[derive(Subcommand)]
pub(crate) enum OperationCommand {
    /// Read one remote operation outcome from its recovery handle.
    Status {
        #[arg(long)]
        recovery: remote::RecoveryHandle,
    },
}

fn main() -> Result<()> {
    commands::run(Cli::parse().command.unwrap_or(Command::Ui))
}

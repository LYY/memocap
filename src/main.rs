use anyhow::Result;
use clap::{Parser, Subcommand};

use memocap::{cli, config, config::Target, install, paths::Paths, remote, server, tui};

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
enum Command {
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
    },
    /// Show newest memories.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Delete one memory by ID.
    Forget { id: i64 },
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

fn main() -> Result<()> {
    let args = Cli::parse();
    match args.command.unwrap_or(Command::Ui) {
        Command::Remember {
            content,
            r#type,
            tags,
            force,
            id,
        } => {
            let id = match config::resolve_target()? {
                Target::Local { database } => {
                    cli::remember(&database, &content, &r#type, &tags, force, id)?
                }
                Target::Remote { address, token } => {
                    remote::remember(&address, &token, &content, &r#type, &tags, force, id)?
                }
            };
            println!("saved #{id}");
        }
        Command::Recall {
            query,
            limit,
            r#type,
            max_chars,
        } => {
            let kind = r#type.as_deref();
            let memories = match config::resolve_target()? {
                Target::Local { database } => {
                    cli::recall(&database, &query, limit, kind, max_chars)?
                }
                Target::Remote { address, token } => {
                    remote::recall(&address, &token, &query, limit, kind, max_chars)?
                }
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::List { limit } => {
            let memories = match config::resolve_target()? {
                Target::Local { database } => cli::list(&database, limit)?,
                Target::Remote { address, token } => remote::list(&address, &token, limit)?,
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::Forget { id } => {
            let deleted = match config::resolve_target()? {
                Target::Local { database } => cli::forget(&database, id)?,
                Target::Remote { address, token } => remote::forget(&address, &token, id)?,
            };
            println!(
                "{}",
                if deleted {
                    format!("deleted #{id}")
                } else {
                    format!("not found #{id}")
                }
            );
        }
        Command::Install { global } => {
            let result = install::install(global)?;
            println!("已配置：{}", result.agents_path.display());
            println!("CLAUDE.md：{}", result.claude_path.display());
            println!("skill：{}", result.skill_path.display());
            println!("程序：{}", result.binary.display());
            println!("数据库：{}", result.database.display());
        }
        Command::Uninstall { global } => {
            println!(
                "{}",
                if install::uninstall(global)? {
                    "removed memocap config"
                } else {
                    "no memocap config found"
                }
            );
        }
        Command::Status { global } => {
            let result = install::status(global)?;
            match config::resolve_target()? {
                Target::Local { database } => {
                    let count = cli::count(&database).unwrap_or(0);
                    print!(
                        "{}",
                        cli::format_status(
                            &database,
                            count,
                            &result.agents_path,
                            result.configured
                        )
                    );
                }
                Target::Remote { address, token } => {
                    let count = remote::count(&address, &token).unwrap_or(0);
                    print!(
                        "{}",
                        cli::format_remote_status(
                            &address,
                            count,
                            &result.agents_path,
                            result.configured
                        )
                    );
                }
            }
        }
        Command::Serve { bind } => {
            let token = config::require_token()?;
            let paths = Paths::discover()?;
            server::serve(&bind, &token, &paths.database)?;
        }
        Command::Ui => tui::run()?,
    }
    Ok(())
}

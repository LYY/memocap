use anyhow::Result;
use clap::{Parser, Subcommand};

use memocap::{install, paths::Paths, store, tui};

#[derive(Parser)]
#[command(name = "memocap", version, about = "Local-first memory for Codex")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Store an explicit local memory.
    Remember {
        content: String,
        #[arg(long, default_value = "context")]
        r#type: String,
        #[arg(long, default_value = "")]
        tags: String,
    },
    /// Search local memory using SQLite full-text search.
    Recall {
        query: String,
        #[arg(long, default_value_t = 5)]
        limit: usize,
    },
    /// Show newest local memories.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Delete one memory by ID.
    Forget { id: i64 },
    /// Copy this binary and configure a managed AGENTS.md block.
    Install {
        /// Configure ~/.codex/AGENTS.md instead of ./AGENTS.md.
        #[arg(long)]
        global: bool,
    },
    /// Remove only memocap's managed AGENTS.md block.
    Uninstall {
        #[arg(long)]
        global: bool,
    },
    /// Print install and database status.
    Status {
        #[arg(long)]
        global: bool,
    },
    /// Open the interactive installer.
    Ui,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Ui) {
        Command::Remember {
            content,
            r#type,
            tags,
        } => {
            let paths = Paths::discover()?;
            let connection = store::open(&paths.database)?;
            let id = store::remember(&connection, &content, &r#type, &tags)?;
            println!("记忆已保存：#{id}");
        }
        Command::Recall { query, limit } => print_memories(store::recall(
            &store::open(&Paths::discover()?.database)?,
            &query,
            limit,
        )?),
        Command::List { limit } => print_memories(store::list(
            &store::open(&Paths::discover()?.database)?,
            limit,
        )?),
        Command::Forget { id } => {
            let paths = Paths::discover()?;
            if store::forget(&store::open(&paths.database)?, id)? {
                println!("已删除记忆：#{id}");
            } else {
                println!("未找到记忆：#{id}");
            }
        }
        Command::Install { global } => {
            let result = install::install(global)?;
            println!("已配置：{}", result.agents_path.display());
            println!("程序：{}", result.binary.display());
            println!("数据库：{}", result.database.display());
        }
        Command::Uninstall { global } => {
            println!(if install::uninstall(global)? {
                "已移除 memocap 配置。"
            } else {
                "未找到 memocap 配置，未做修改。"
            });
        }
        Command::Status { global } => {
            let result = install::status(global)?;
            let count = store::open(&result.database)
                .and_then(|connection| store::count(&connection))
                .unwrap_or(0);
            println!("AGENTS.md：{}", result.agents_path.display());
            println!("已注入：{}", if result.configured { "是" } else { "否" });
            println!("数据库：{}", result.database.display());
            println!("记忆数量：{count}");
        }
        Command::Ui => tui::run()?,
    }
    Ok(())
}

fn print_memories(memories: Vec<store::Memory>) {
    if memories.is_empty() {
        println!("没有找到本地记忆。");
        return;
    }
    for memory in memories {
        println!("#{} [{}] {}", memory.id, memory.kind, memory.content);
        if !memory.tags.is_empty() {
            println!("  标签：{}", memory.tags);
        }
        println!("  时间：{}", memory.created_at);
    }
}

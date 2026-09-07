use anyhow::{bail, Result};

use memocap::{
    cli, config, config::Target, install, paths::Paths, remote, server, store::ScopeMigration, tui,
};

use crate::{Command, ScopeCommand};

pub(crate) fn run(command: Command) -> Result<()> {
    match command {
        Command::Remember {
            content,
            r#type,
            tags,
            force,
            id,
            global,
            topic,
        } => {
            let id = match config::resolve_target()? {
                Target::Local { database } => {
                    let scope = cli::memory_scope(global)?;
                    cli::remember_scoped(
                        &database,
                        &scope,
                        cli::ScopedRemember {
                            content: &content,
                            kind: &r#type,
                            tags: &tags,
                            topic: topic.as_deref(),
                            force,
                            overwrite_id: id,
                        },
                    )?
                }
                Target::Remote { address, token } => remote::remember(
                    &address,
                    &token,
                    remote::RememberRequest {
                        scope: &cli::memory_scope(global)?,
                        content: &content,
                        kind: &r#type,
                        tags: &tags,
                        topic_key: topic.as_deref(),
                        force,
                        overwrite_id: id,
                    },
                )?,
            };
            println!("saved #{id}");
        }
        Command::Recall {
            query,
            limit,
            r#type,
            max_chars,
            global,
        } => {
            let kind = r#type.as_deref();
            let memories = match config::resolve_target()? {
                Target::Local { database } => {
                    let scope = cli::memory_scope(global)?;
                    cli::recall_scoped(
                        &database,
                        &scope,
                        cli::ScopedRecall {
                            query: &query,
                            limit,
                            kind,
                            max_chars,
                        },
                    )?
                }
                Target::Remote { address, token } => remote::recall(
                    &address,
                    &token,
                    remote::RecallRequest {
                        scope: &cli::memory_scope(global)?,
                        query: &query,
                        limit,
                        kind,
                        max_chars,
                    },
                )?,
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::List { limit, global } => {
            let memories = match config::resolve_target()? {
                Target::Local { database } => {
                    cli::list_scoped(&database, &cli::memory_scope(global)?, limit)?
                }
                Target::Remote { address, token } => {
                    remote::list(&address, &token, &cli::memory_scope(global)?, limit)?
                }
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::Forget { id, global } => {
            let deleted = match config::resolve_target()? {
                Target::Local { database } => {
                    cli::forget_scoped(&database, &cli::memory_scope(global)?, id)?
                }
                Target::Remote { address, token } => {
                    remote::forget(&address, &token, &cli::memory_scope(global)?, id)?
                }
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
        Command::Scope { command } => run_scope_command(command)?,
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
        Command::Status { global } => run_status(global)?,
        Command::Serve { bind } => {
            let token = config::require_token()?;
            let paths = Paths::discover()?;
            server::serve(&bind, &token, &paths.database)?;
        }
        Command::Ui => tui::run()?,
    }
    Ok(())
}

fn run_scope_command(command: ScopeCommand) -> Result<()> {
    let database = cli::local_database()?;
    let active_scope = cli::current_scope()?;
    match command {
        ScopeCommand::Show => print!("{}", cli::format_scope_show(&active_scope)),
        ScopeCommand::Migrate {
            from,
            id,
            all,
            dry_run,
            yes,
        } => {
            if yes && !all {
                bail!("--yes requires --all");
            }
            if all && (dry_run == yes) {
                bail!("--all requires exactly one of --dry-run or --yes");
            }
            let migration = match (id, all) {
                (Some(id), false) => ScopeMigration::One(id),
                (None, true) => ScopeMigration::All,
                (Some(_), true) | (None, false) => bail!("select exactly one of --id or --all"),
            };
            let moved = cli::migrate_scope(
                &database,
                cli::ScopeMigrationRequest {
                    source: &from,
                    destination: active_scope.scope(),
                    migration,
                    dry_run,
                },
            )?;
            println!(
                "{} {moved} memories",
                if dry_run { "would migrate" } else { "migrated" }
            );
        }
    }
    Ok(())
}

fn run_status(global: bool) -> Result<()> {
    let result = install::status(global)?;
    match config::resolve_target()? {
        Target::Local { database } => {
            let scope = cli::current_scope()?;
            let counts = cli::scope_counts(&database, scope.scope())?;
            print!(
                "{}",
                cli::format_status(
                    &database,
                    cli::LocalStatus {
                        scope: scope.scope(),
                        counts,
                        agents_path: &result.agents_path,
                        configured: result.configured,
                    }
                )
            );
        }
        Target::Remote { address, token } => {
            let scope = cli::current_scope()?;
            let count = remote::count(&address, &token, scope.scope())?;
            print!(
                "{}",
                cli::format_remote_status(&address, count, &result.agents_path, result.configured)
            );
        }
    }
    Ok(())
}

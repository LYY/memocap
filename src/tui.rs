use std::{io, path::Path, time::Duration};

use anyhow::{Context, Result};
use crossterm::{
    event::{self, Event, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Terminal,
};

use crate::{
    cli,
    config::{self, Target},
    remote,
    scope::RepositoryId,
    store::InventoryMemory,
};

const ACTIONS: [&str; 3] = ["Status", "List visible memories", "Exit"];
mod paging;
use paging::{handle_key, InventoryPage, UiCommand, UiState, UiView};

pub fn run() -> Result<()> {
    enable_raw_mode().context("启用终端原始模式失败")?;
    execute!(io::stdout(), EnterAlternateScreen).context("进入 TUI 屏幕失败")?;
    let restore = RestoreTerminal;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    let result = run_loop(&mut terminal);
    terminal.show_cursor().ok();
    drop(restore);
    result
}

fn run_loop(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    let mut state = UiState::new();
    loop {
        terminal.draw(|frame| render(frame, &state))?;
        if !event::poll(Duration::from_millis(250))? {
            continue;
        }
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Release {
                continue;
            }
            match handle_key(&mut state, key.code) {
                UiCommand::Continue => {}
                UiCommand::Exit => return Ok(()),
                UiCommand::ShowStatus => state.view = UiView::Message(status_message()),
                UiCommand::ShowInventory => state.view = visible_inventory_view(),
            }
        }
    }
}

fn status_message() -> String {
    match config::resolve_target() {
        Ok(Target::Local { database }) => match cli::current_scope() {
            Ok(scope) => status_message_at(&database, scope.repository()),
            Err(error) => format!("读取 repository 失败：{error:#}"),
        },
        Ok(Target::Remote { address, token }) => match cli::current_scope() {
            Ok(scope) => remote_status_message(&address, &token, scope.repository()),
            Err(error) => format!("读取 repository 失败：{error:#}"),
        },
        Err(error) => format!("读取 repository 失败：{error:#}"),
    }
}

fn status_message_at(database: &Path, repository: &RepositoryId) -> String {
    match cli::visible_status(database, repository) {
        Ok(status) => format!(
            "database: {}\nrepository_id: {}\n{}",
            database.display(),
            repository,
            format_tui_status(&status)
        ),
        Err(error) => format!("读取数据库失败：{error:#}"),
    }
}

fn remote_status_message(address: &str, token: &str, repository: &RepositoryId) -> String {
    match remote::status(address, token, repository) {
        Ok(status) => format!(
            "remote: {address}\nrepository_id: {repository}\n{}",
            format_tui_status(&status.status)
        ),
        Err(error) => format!("读取远程状态失败：{error:#}"),
    }
}

fn format_tui_status(status: &crate::store::VisibleStackStatus) -> String {
    let mut output = format!("schema: {}\n", status.schema_version);
    for count in &status.placements {
        let placement = count
            .placement
            .strip_prefix("repository:")
            .map_or(count.placement.as_str(), |_| "repository");
        output.push_str(&format!(
            "{} {} {}/{}\n",
            count.source_order, placement, count.addressable_count, count.effective_count
        ));
    }
    output.push_str(&format!(
        "total addressable/effective: {}/{}",
        status.addressable_total, status.effective_total
    ));
    output
}

fn visible_inventory_view() -> UiView {
    let scope = match cli::current_scope() {
        Ok(scope) => scope,
        Err(error) => return UiView::Message(format!("读取 repository 失败：{error:#}")),
    };
    let memories = match config::resolve_target() {
        Ok(Target::Local { database }) => visible_inventory_at(&database, scope.repository()),
        Ok(Target::Remote { address, token }) => {
            remote_inventory_at(&address, &token, scope.repository())
        }
        Err(error) => return UiView::Message(format!("读取状态失败：{error:#}")),
    };
    match memories {
        Ok(memories) => UiView::Inventory(InventoryPage::new(memories)),
        Err(error) => UiView::Message(format!("读取 memory 失败：{error:#}")),
    }
}

fn visible_inventory_at(
    database: &Path,
    repository: &RepositoryId,
) -> Result<Vec<InventoryMemory>> {
    cli::list_visible(database, repository)
}

fn remote_inventory_at(
    address: &str,
    token: &str,
    repository: &RepositoryId,
) -> Result<Vec<InventoryMemory>> {
    let status = remote::status(address, token, repository)?;
    let limit = usize::try_from(status.status.addressable_total)
        .context("远程 addressable inventory count 超出本地范围")?;
    let inventory = remote::list(address, token, repository, None, limit)?;
    if inventory.len() != limit {
        anyhow::bail!("remote inventory response count does not match status");
    }
    Ok(inventory)
}

fn render(frame: &mut ratatui::Frame, state: &UiState) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(5),
            Constraint::Min(5),
        ])
        .split(frame.area());
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                "memocap",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  local-first SQLite memory for OpenCode"),
        ]))
        .alignment(Alignment::Center)
        .block(Block::default().borders(Borders::ALL)),
        areas[0],
    );
    let items = ACTIONS.map(ListItem::new);
    let mut menu_state = ListState::default();
    menu_state.select(Some(state.selected));
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().title(" 操作 ").borders(Borders::ALL))
            .highlight_style(Style::default().bg(Color::Blue).fg(Color::White))
            .highlight_symbol("> "),
        areas[1],
        &mut menu_state,
    );
    match &state.view {
        UiView::Message(message) => frame.render_widget(
            Paragraph::new(message.as_str())
                .wrap(Wrap { trim: true })
                .block(Block::default().title(" 状态 ").borders(Borders::ALL)),
            areas[2],
        ),
        UiView::Inventory(inventory) => {
            let title = format!(
                " Inventory {}/{} ",
                inventory.position(),
                inventory.memories.len()
            );
            let message = cli::format_memories(inventory.current());
            frame.render_widget(
                Paragraph::new(message)
                    .wrap(Wrap { trim: true })
                    .block(Block::default().title(title).borders(Borders::ALL)),
                areas[2],
            );
        }
    }
}

struct RestoreTerminal;

impl Drop for RestoreTerminal {
    fn drop(&mut self) {
        disable_raw_mode().ok();
        execute!(io::stdout(), LeaveAlternateScreen).ok();
    }
}

#[cfg(test)]
mod paging_tests;
#[cfg(test)]
mod remote_test_support;
#[cfg(test)]
mod remote_tests;
#[cfg(test)]
mod tests;

use super::*;
use crossterm::event::KeyCode;
use ratatui::{backend::TestBackend, Terminal};

use super::tests::{repository, save};

fn rendered_screen(state: &UiState) -> String {
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).expect("test terminal should initialize");
    terminal
        .draw(|frame| render(frame, state))
        .expect("TUI should render");
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect()
}

#[test]
fn inventory_page_down_reaches_universal_shadow_at_80x24() {
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let beta = "team/beta".parse().expect("domain should parse");
    let alpha = "team/alpha".parse().expect("domain should parse");
    let mut connection = crate::store::open(&database).expect("database should open");
    crate::store::create_domain(&mut connection, &beta).expect("domain should register");
    crate::store::create_domain(&mut connection, &alpha).expect("domain should register");
    crate::store::attach_domain(&mut connection, &repository, &beta, None)
        .expect("beta should attach");
    crate::store::attach_domain(&mut connection, &repository, &alpha, None)
        .expect("alpha should attach");

    let repository_placement = crate::scope::PlacementId::Repository(repository.clone());
    let beta_placement = crate::scope::PlacementId::Domain(beta);
    let alpha_placement = crate::scope::PlacementId::Domain(alpha);
    save(
        &connection,
        &repository_placement,
        "repository release",
        "release",
    );
    save(&connection, &repository_placement, "repository second", "");
    save(&connection, &repository_placement, "repository third", "");
    save(&connection, &beta_placement, "beta release", "release");
    save(&connection, &beta_placement, "beta second", "");
    save(&connection, &beta_placement, "beta third", "");
    save(&connection, &alpha_placement, "alpha release", "release");
    save(&connection, &alpha_placement, "alpha second", "");
    save(&connection, &alpha_placement, "alpha third", "");
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal release",
        "release",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal second",
        "",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal third",
        "",
    );
    save(
        &connection,
        &crate::scope::PlacementId::Universal,
        "universal fourth",
        "",
    );

    let memories = visible_inventory_at(&database, &repository).expect("inventory should load");
    let mut state = UiState::new();
    state.selected = 1;
    state.view = UiView::Inventory(InventoryPage::new(memories));
    for _ in 0..4 {
        assert_eq!(
            handle_key(&mut state, KeyCode::PageDown),
            UiCommand::Continue
        );
    }

    let screen = rendered_screen(&state);
    assert!(screen.contains("universal release"));
    assert!(screen.contains("source_order: 3"));
    assert!(screen.contains("visibility: shadowed"));
    assert!(screen.contains("shadowed_by: source 0"));
}

#[test]
fn inventory_paging_reaches_records_past_twenty() {
    let directory = tempfile::tempdir().expect("temporary database directory should exist");
    let database = directory.path().join("memocap.db");
    let repository = repository();
    let connection = crate::store::open(&database).expect("database should open");
    let placement = crate::scope::PlacementId::Repository(repository.clone());
    for index in 0..21 {
        let content = format!("inventory record {index}");
        save(&connection, &placement, &content, "");
    }

    let memories = visible_inventory_at(&database, &repository).expect("inventory should load");
    assert_eq!(memories.len(), 21);
    let mut state = UiState::new();
    state.selected = 1;
    state.view = UiView::Inventory(InventoryPage::new(memories));
    for _ in 0..7 {
        assert_eq!(
            handle_key(&mut state, KeyCode::PageDown),
            UiCommand::Continue
        );
    }

    assert!(rendered_screen(&state).contains("inventory record 0"));

    assert_eq!(handle_key(&mut state, KeyCode::PageUp), UiCommand::Continue);
    assert!(rendered_screen(&state).contains("inventory record 3"));

    assert_eq!(handle_key(&mut state, KeyCode::Down), UiCommand::Continue);
    assert!(rendered_screen(&state).contains("inventory record 2"));

    assert_eq!(handle_key(&mut state, KeyCode::Up), UiCommand::Continue);
    assert!(rendered_screen(&state).contains("inventory record 3"));
}

#[test]
fn inventory_escape_returns_to_menu_and_exit_remains_available() {
    let mut state = UiState::new();
    state.selected = 1;
    state.view = UiView::Inventory(InventoryPage::new(Vec::new()));

    assert_eq!(
        handle_key(&mut state, KeyCode::Char('x')),
        UiCommand::Continue
    );
    assert_eq!(handle_key(&mut state, KeyCode::Esc), UiCommand::Continue);
    assert_eq!(handle_key(&mut state, KeyCode::Down), UiCommand::Continue);
    assert_eq!(handle_key(&mut state, KeyCode::Enter), UiCommand::Exit);
}

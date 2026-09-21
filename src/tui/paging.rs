use crossterm::event::KeyCode;

use crate::store::InventoryMemory;

pub(super) const INVENTORY_PAGE_STEP: usize = 3;
pub(super) const WELCOME_MESSAGE: &str =
    "Recall-first, then answer. Value-store decisions, preferences, tasks, agreements, and context.";

pub(super) enum UiView {
    Message(String),
    Inventory(InventoryPage),
}

pub(super) struct InventoryPage {
    pub(super) memories: Vec<InventoryMemory>,
    index: usize,
}

impl InventoryPage {
    pub(super) fn new(memories: Vec<InventoryMemory>) -> Self {
        Self { memories, index: 0 }
    }

    pub(super) fn forward(&mut self, step: usize) {
        let last = self.memories.len().saturating_sub(1);
        self.index = self.index.saturating_add(step).min(last);
    }

    pub(super) fn backward(&mut self, step: usize) {
        self.index = self.index.saturating_sub(step);
    }

    pub(super) fn current(&self) -> &[InventoryMemory] {
        match self.memories.get(self.index) {
            Some(memory) => std::slice::from_ref(memory),
            None => &[],
        }
    }

    pub(super) fn position(&self) -> usize {
        match self.memories.is_empty() {
            true => 0,
            false => self.index + 1,
        }
    }
}

pub(super) struct UiState {
    pub(super) selected: usize,
    pub(super) view: UiView,
}

impl UiState {
    pub(super) fn new() -> Self {
        Self {
            selected: 0,
            view: UiView::Message(WELCOME_MESSAGE.to_owned()),
        }
    }

    #[cfg(test)]
    pub(super) fn message(selected: usize, message: &str) -> Self {
        Self {
            selected,
            view: UiView::Message(message.to_owned()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UiCommand {
    Continue,
    Exit,
    ShowStatus,
    ShowInventory,
}

pub(super) fn handle_key(state: &mut UiState, key: KeyCode) -> UiCommand {
    match key {
        KeyCode::Char('q') => UiCommand::Exit,
        KeyCode::Esc if matches!(&state.view, UiView::Inventory(_)) => {
            state.view = UiView::Message(WELCOME_MESSAGE.to_owned());
            UiCommand::Continue
        }
        KeyCode::Esc => UiCommand::Exit,
        KeyCode::Left | KeyCode::Char('h') if matches!(&state.view, UiView::Inventory(_)) => {
            state.view = UiView::Message(WELCOME_MESSAGE.to_owned());
            UiCommand::Continue
        }
        KeyCode::Up | KeyCode::Char('k') => match &mut state.view {
            UiView::Inventory(inventory) => {
                inventory.backward(1);
                UiCommand::Continue
            }
            UiView::Message(_) => {
                state.selected = state.selected.saturating_sub(1);
                UiCommand::Continue
            }
        },
        KeyCode::Down | KeyCode::Char('j') => match &mut state.view {
            UiView::Inventory(inventory) => {
                inventory.forward(1);
                UiCommand::Continue
            }
            UiView::Message(_) => {
                state.selected = (state.selected + 1).min(super::ACTIONS.len() - 1);
                UiCommand::Continue
            }
        },
        KeyCode::PageUp => match &mut state.view {
            UiView::Inventory(inventory) => {
                inventory.backward(INVENTORY_PAGE_STEP);
                UiCommand::Continue
            }
            UiView::Message(_) => UiCommand::Continue,
        },
        KeyCode::PageDown => match &mut state.view {
            UiView::Inventory(inventory) => {
                inventory.forward(INVENTORY_PAGE_STEP);
                UiCommand::Continue
            }
            UiView::Message(_) => UiCommand::Continue,
        },
        KeyCode::Enter if matches!(&state.view, UiView::Inventory(_)) => UiCommand::Continue,
        KeyCode::Enter => match state.selected {
            0 => UiCommand::ShowStatus,
            1 => UiCommand::ShowInventory,
            _ => UiCommand::Exit,
        },
        _ => UiCommand::Continue,
    }
}

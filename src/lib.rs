#![forbid(unsafe_code)]

pub mod activity;
pub mod cli;
pub mod config;
pub mod hosts;
pub mod inspection;
pub mod inventory;
pub mod operation;
pub mod organization;
pub mod paths;
mod readonly;
pub mod receipt;
pub mod remote;
pub mod repository;
pub mod scope;
pub mod server;
pub mod store;
pub mod tui;

pub const SKILL_GUIDANCE: &str = include_str!("../skills/memocap/SKILL.md");

#[must_use]
pub fn skill_markdown() -> String {
    SKILL_GUIDANCE.replace("\r\n", "\n")
}

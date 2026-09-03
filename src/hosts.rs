use crate::agents_block;

/// Official OpenCode plugin registration command.
pub const OPENCODE_INSTALL: &str = "opencode plugin @lyy-gh/memocap";

/// Unsupported legacy compatibility commands retained for existing users.
pub const CODEX_INSTALL: &str = "memocap install";
pub const CLAUDE_INSTALL: &str = "memocap install";
pub const PI_INSTALL: &str = "pi install npm:@lyy-gh/memocap";

#[must_use]
pub fn official_hosts() -> [&'static str; 1] {
    [OPENCODE_INSTALL]
}

/// Unsupported Claude / Pi compatibility skill body using the shared CLI.
#[must_use]
pub fn skill_markdown(binary: &str) -> String {
    format!(
        "---\nname: memocap\ndescription: Shared SQLite memory via the memocap CLI. Recall first every utterance. Store decisions, preferences, tasks, agreements, and context after a similar-check.\n---\n\nUse `{binary}` only. Do not open another database.\n\n{}\n",
        agents_block(binary)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_is_the_only_official_host() {
        assert_eq!(official_hosts(), [OPENCODE_INSTALL]);
        assert_eq!(OPENCODE_INSTALL, "opencode plugin @lyy-gh/memocap");
    }

    #[test]
    fn skill_uses_shared_cli() {
        let skill = skill_markdown("memocap");
        assert!(skill.contains("memocap recall"));
        assert!(skill.contains("Do not open another database"));
        assert!(skill.contains("言必检"));
        assert!(skill.contains("值必存"));
        assert!(!skill.to_lowercase().contains("chroma"));
        assert!(!skill.to_lowercase().contains("embedding"));
    }
}

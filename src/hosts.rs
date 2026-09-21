/// Official OpenCode plugin registration command.
pub const OPENCODE_INSTALL: &str = "opencode plugin @lyy-gh/memocap";

#[must_use]
pub fn official_hosts() -> [&'static str; 1] {
    [OPENCODE_INSTALL]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_is_the_only_official_host() {
        assert_eq!(official_hosts(), [OPENCODE_INSTALL]);
        assert_eq!(OPENCODE_INSTALL, "opencode plugin @lyy-gh/memocap");
    }
}

use std::collections::BTreeSet;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::{recall::fts_query, MatchMode, RecallOptions};

const SHARED_CHARACTERS: usize = 3;
const MAX_FRAGMENTS: usize = 64;
const MAX_ALTERNATIVES: usize = 256;

pub(super) fn expand_query(connection: &Connection, options: RecallOptions<'_>) -> Result<String> {
    if !options.query.chars().any(is_cjk) {
        return Ok(fts_query(options.query, options.match_mode));
    }
    let mut expressions = Vec::new();
    for part in options.query.split_whitespace() {
        let term = part.replace('"', "");
        if term.is_empty() {
            continue;
        }
        let fragments = fragments(&term);
        ensure!(
            fragments.len() <= MAX_FRAGMENTS,
            "CJK lexical query has too many fragments"
        );
        let alternatives = if fragments.is_empty() {
            BTreeSet::from([term.clone()])
        } else {
            expand_term(connection, &term, &fragments)?
        };
        expressions.push(format!(
            "({})",
            alternatives
                .iter()
                .map(|token| fts_query(token, MatchMode::All))
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
    }
    Ok(expressions.join(match options.match_mode {
        MatchMode::All => " AND ",
        MatchMode::Any => " OR ",
    }))
}

fn expand_term(
    connection: &Connection,
    term: &str,
    fragments: &BTreeSet<String>,
) -> Result<BTreeSet<String>> {
    let mut alternatives = BTreeSet::from([term.to_lowercase()]);
    let anchors = term
        .split(|character: char| is_cjk(character) || !character.is_alphanumeric())
        .filter(|anchor| !anchor.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let mut statement = connection.prepare("SELECT content, tags FROM memories")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        for column in 0..2 {
            let text: String = row.get(column)?;
            for token in text.split(|character: char| !character.is_alphanumeric()) {
                if !fragments.iter().any(|fragment| token.contains(fragment)) {
                    continue;
                }
                let token = token.to_lowercase();
                if anchors.iter().all(|anchor| token.contains(anchor)) {
                    alternatives.insert(token);
                    ensure!(
                        alternatives.len() <= MAX_ALTERNATIVES,
                        "CJK lexical query expands to too many terms"
                    );
                }
            }
        }
    }
    Ok(alternatives)
}

fn fragments(term: &str) -> BTreeSet<String> {
    term.split(|character| !is_cjk(character))
        .flat_map(|run| {
            let characters = run.chars().collect::<Vec<_>>();
            let width = SHARED_CHARACTERS.min(characters.len());
            if width < 2 {
                return Vec::new();
            }
            characters
                .windows(width)
                .map(|window| window.iter().collect())
                .collect()
        })
        .collect()
}

fn is_cjk(character: char) -> bool {
    matches!(character,
        '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' |
        '\u{f900}'..='\u{faff}' | '\u{20000}'..='\u{323af}' |
        '\u{3040}'..='\u{30ff}' | '\u{ac00}'..='\u{d7af}')
}

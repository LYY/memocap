use anyhow::{bail, ensure, Result};
use std::{iter::Peekable, str::Chars};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Token {
    Word(String),
    String(String),
    Symbol(char),
}

impl Token {
    pub(super) fn word(&self) -> Option<&str> {
        match self {
            Self::Word(word) => Some(word),
            Self::String(_) | Self::Symbol(_) => None,
        }
    }
}

pub(super) fn tokens(sql: &str) -> Result<Vec<Token>> {
    let mut input = sql.chars().peekable();
    let mut result = Vec::new();
    while let Some(character) = input.next() {
        match character {
            whitespace if whitespace.is_whitespace() => {}
            '-' if input.peek() == Some(&'-') => {
                input.next();
                for next in input.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            '/' if input.peek() == Some(&'*') => {
                input.next();
                block_comment(&mut input)?;
            }
            quote @ ('\'' | '"' | '`' | '[') => {
                result.push(quoted(&mut input, quote)?);
            }
            start if start.is_alphanumeric() || start == '_' => {
                let mut word = String::from(start);
                while input
                    .peek()
                    .is_some_and(|next| next.is_alphanumeric() || *next == '_' || *next == '$')
                {
                    if let Some(next) = input.next() {
                        word.push(next);
                    }
                }
                result.push(Token::Word(word.to_ascii_lowercase()));
            }
            symbol => result.push(Token::Symbol(symbol)),
        }
    }
    Ok(result)
}

fn block_comment(input: &mut Peekable<Chars<'_>>) -> Result<()> {
    while let Some(next) = input.next() {
        if next == '*' && input.peek() == Some(&'/') {
            input.next();
            return Ok(());
        }
    }
    bail!("unterminated schema SQL comment")
}

fn quoted(input: &mut Peekable<Chars<'_>>, quote: char) -> Result<Token> {
    let end = if quote == '[' { ']' } else { quote };
    let mut text = String::new();
    while let Some(next) = input.next() {
        if next == end {
            if quote != '[' && input.peek() == Some(&end) {
                input.next();
            } else {
                return Ok(if quote == '\'' {
                    Token::String(text)
                } else {
                    Token::Word(text.to_ascii_lowercase())
                });
            }
        }
        text.push(next);
    }
    bail!("unterminated schema SQL quote")
}

pub(super) fn table_items(sql: &str) -> Result<Vec<Vec<Token>>> {
    let tokens = tokens(sql)?;
    let Some(open) = tokens.iter().position(|token| *token == Token::Symbol('(')) else {
        bail!("schema table has no column list");
    };
    ensure!(
        tokens.first().and_then(Token::word) == Some("create")
            && tokens.get(1).and_then(Token::word) == Some("table"),
        "expected ordinary schema table"
    );
    let mut depth = 0usize;
    let mut items = Vec::new();
    let mut item = Vec::new();
    for (offset, token) in tokens[open + 1..].iter().enumerate() {
        match token {
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') if depth == 0 => {
                items.push(item);
                ensure!(
                    tokens[open + offset + 2..]
                        .iter()
                        .all(|token| *token == Token::Symbol(';')),
                    "unsupported table suffix"
                );
                return Ok(items);
            }
            Token::Symbol(')') => depth -= 1,
            Token::Symbol(',') if depth == 0 => {
                items.push(std::mem::take(&mut item));
                continue;
            }
            _ => {}
        }
        item.push(token.clone());
    }
    bail!("schema table column list is unbalanced")
}

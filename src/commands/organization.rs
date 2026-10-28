use anyhow::{bail, Result};
use clap::Subcommand;
use memocap::{
    config,
    organization::{self, Error, Output},
    paths::Paths,
    receipt::{Receipt, Status},
};
use serde::de::DeserializeOwned;
use std::{
    io::{self, Read},
    time::Instant,
};

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Read up to 20 raw memories by ID keyset. JSON stdin: selection, after_id, upper_id.
    Page,
    /// Read exact ID/placement keys. JSON stdin: keys.
    Read,
    /// Apply one confirmed atomic group. JSON stdin: mode, group, dependencies.
    Apply,
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Self::Page => "organize_page",
            Self::Read => "organize_read",
            Self::Apply => "organize_apply",
        }
    }
}

pub(crate) fn run(command: Command, options: &crate::Cli) -> Result<()> {
    let start = Instant::now();
    let mut receipt = Receipt::new(command.name());
    receipt.caller = options.caller_json.clone().unwrap_or_default();
    let result = execute(command, options);
    match result {
        Ok(output) => {
            receipt.returned_ids = match &output {
                Output::Page(page) => {
                    if page.exhausted {
                        receipt.status = Status::Empty;
                    }
                    page.records
                        .iter()
                        .map(|snapshot| i64::from(snapshot.id))
                        .collect()
                }
                Output::Read(read) => read
                    .records
                    .iter()
                    .filter_map(|record| {
                        record
                            .snapshot
                            .as_ref()
                            .map(|snapshot| i64::from(snapshot.id))
                    })
                    .collect(),
                Output::Apply(applied) => {
                    receipt.outcome = Some("committed".into());
                    applied
                        .records
                        .iter()
                        .map(|snapshot| i64::from(snapshot.id))
                        .collect()
                }
            };
            receipt.organization = Some(output);
        }
        Err(error) => error.record(&mut receipt),
    }
    receipt.finish(start);
    println!("{}", serde_json::to_string(&receipt)?);
    if let Some(error) = receipt
        .error
        .as_ref()
        .filter(|error| error.code == "invalid_arguments")
    {
        clap::Error::raw(clap::error::ErrorKind::ArgumentConflict, &error.message).exit();
    }
    if !receipt.succeeded() {
        bail!(
            "{}",
            receipt
                .error
                .as_ref()
                .map_or("organization failed", |error| &error.message)
        );
    }
    Ok(())
}

fn execute(command: Command, options: &crate::Cli) -> organization::Result<Output> {
    if !options.repo.is_empty() {
        return Err(Error::before(
            "invalid_arguments",
            "organize scans the complete local database and rejects --repo",
        ));
    }
    if config::configured_address().is_some() {
        return Err(Error::before(
            "unsupported_backend",
            "organization supports only the configured local backend",
        ));
    }
    if !options.json {
        return Err(Error::before(
            "invalid_arguments",
            "use memocap organize page|read|apply --json with a JSON object on stdin",
        ));
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| Error::before("invalid_request", error))?;
    let database = Paths::discover()
        .map_err(|error| Error::before("not_initialized", error))?
        .database;
    match command {
        Command::Page => organization::page(&database, &parse(&input)?).map(Output::Page),
        Command::Read => organization::read(&database, &parse(&input)?).map(Output::Read),
        Command::Apply => organization::apply(&database, &parse(&input)?).map(Output::Apply),
    }
}

fn parse<T: DeserializeOwned>(input: &str) -> organization::Result<T> {
    serde_json::from_str(input).map_err(|error| Error::before("invalid_request", error))
}

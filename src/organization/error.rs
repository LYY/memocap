use crate::receipt::{Receipt, Status};
use std::fmt;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub outcome: &'static str,
    pub message: String,
    pub rejected: bool,
}

impl Error {
    pub fn before(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            outcome: "not_started",
            message: message.to_string(),
            rejected: false,
        }
    }

    pub(super) fn conflict(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            outcome: "rolled_back",
            message: message.to_string(),
            rejected: true,
        }
    }

    pub(super) fn database(error: impl ToString) -> Self {
        Self::before("database_error", error)
    }

    pub(super) fn rolled_back(error: impl ToString) -> Self {
        Self {
            outcome: "rolled_back",
            ..Self::database(error)
        }
    }

    pub fn record(self, receipt: &mut Receipt) {
        receipt.fail(self.code, self.message);
        if self.rejected {
            receipt.status = Status::Rejected;
        }
        if self.outcome == "outcome_unknown" {
            receipt.status = Status::OutcomeUnknown;
        }
        receipt.outcome = Some(self.outcome.into());
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

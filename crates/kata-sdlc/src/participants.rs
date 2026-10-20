//! Who takes part in a build: the one answer to which repositories are in it, where each is checked
//! out, and which uncommitted files each one owns.
use crate::start::BuildError;
use serde::Serialize;
use std::path::Path;

/// One repository of a build. A build log row (`intent/<system>/<change>/build/<repo>.md`) is owned
/// by `<repo>`, wherever it was written.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Participant {
    pub repo: String,
    pub path: String,
    pub master: bool,
    /// Uncommitted files in this repository's own working tree, build log rows excluded.
    pub files: Vec<String>,
    /// Uncommitted build log rows this repository owns, as paths in the master repository.
    pub rows: Vec<String>,
}

pub fn participants(
    _folder: &Path,
    _master_repo: &str,
    _system: &str,
    _change: &str,
    _pending: Option<&str>,
) -> Result<Vec<Participant>, BuildError> {
    Ok(Vec::new())
}

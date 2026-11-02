//! What `change show` prints: the change's record, the branch it uses and where every repository of its
//! system stands. Kata reads the answer; the program decides what it holds.
use super::{Place, Program, ProgramError};
use serde::Deserialize;
use std::collections::BTreeMap;

/// One pull request the program recorded in `change.yml`.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecordedByPlugin {
    pub repo: String,
    pub url: String,
    pub number: u64,
    pub pushed: String,
}

/// The change's `change.yml`.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChangeRecord {
    pub branch: String,
    #[serde(rename = "type")]
    pub work_type: String,
    pub scope: String,
    pub base: String,
    /// Left out of the file until `change.done` writes it.
    #[serde(default, rename = "pullRequests")]
    pub pull_requests: Vec<RecordedByPlugin>,
}

/// One repository of the change's system.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RepoStanding {
    pub path: String,
    #[serde(rename = "checkedOut")]
    pub checked_out: bool,
    pub branch: Option<String>,
    pub base: Option<String>,
}

/// The answer of `change show --json --change <c>`.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChangeShow {
    pub change: String,
    pub system: String,
    /// The branch the change uses: its record, else `branch.md`, else `change/<change>`.
    pub branch: String,
    /// None for a change started before the program wrote `change.yml`.
    pub record: Option<ChangeRecord>,
    #[serde(default)]
    pub repos: BTreeMap<String, RepoStanding>,
    /// With `--refresh`: each pull request's state by address (`OPEN`, `MERGED`, `CLOSED`), null when gh cannot read it.
    #[serde(default)]
    pub states: Option<BTreeMap<String, Option<String>>>,
}

impl Program {
    /// Reads `change show` for `change`; with `refresh` the program also asks GitHub for each pull request's
    /// state. A change the program does not find is `CouldNotRun` with its words.
    pub fn change_show(
        &self,
        place: &Place,
        change: &str,
        refresh: bool,
    ) -> Result<ChangeShow, ProgramError> {
        let mut command = vec!["change", "show", "--json", "--change", change];
        if refresh {
            command.push("--refresh");
        }
        let answer = self.run(&command, place)?;
        serde_json::from_value(answer.clone()).map_err(|e| ProgramError::CouldNotRun {
            message: format!("change show printed something Kata cannot read ({e}): {answer}"),
        })
    }
}

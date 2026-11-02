//! What the program recorded and what it will run: `status --json` (the ledger of a change's event runs on
//! this machine) and `hooks --json` (the team's hooks as committed on the master's base branch).
use crate::ai_sdlc::{Place, Program, ProgramError};
use serde::Deserialize;

/// What a failed blocking hook asks for.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OnFailure {
    /// The agent is sent back to fix it.
    Fix,
    /// The run stops.
    Stop,
}

/// One hook of a recorded run.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookRecord {
    pub id: String,
    /// `passed`, `failed` or `could-not-run`.
    pub outcome: String,
    /// The last 200 lines of the hook's output.
    #[serde(default)]
    pub output: String,
}

/// The blocking hook that stopped a recorded run.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedHook {
    pub id: String,
    pub on_failure: OnFailure,
}

/// One event run as the ledger records it.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub event: String,
    /// What the run is about: the repository's head commit for `build.finish`.
    pub key: String,
    /// `passed`, `failed`, `refused` or `could-not-run`.
    pub outcome: String,
    #[serde(default)]
    pub hooks: Vec<HookRecord>,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub failed: Option<FailedHook>,
    /// True while the key is still the repository's head.
    #[serde(default)]
    pub current: bool,
    /// When the run was recorded, as an ISO 8601 time, which orders runs across repositories.
    #[serde(default)]
    pub at: Option<String>,
}

/// One repository's ledger, oldest run first.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRuns {
    pub repo: String,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub runs: Vec<RunRecord>,
}

/// The program's `status` answer: the repositories that have a ledger.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(default)]
    pub repos: Vec<RepoRuns>,
}

/// One hook as it will run.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredHook {
    pub id: String,
    pub event: String,
    pub when: String,
    /// The repositories it runs in; none means every one the event runs in.
    #[serde(default)]
    pub repos: Option<Vec<String>>,
    pub blocking: bool,
    pub on_failure: OnFailure,
    /// Its time limit in seconds; the plugin's default is 600.
    #[serde(default = "default_hook_timeout")]
    pub timeout: u64,
}

fn default_hook_timeout() -> u64 {
    600
}

/// The program's `hooks` answer.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hooks {
    #[serde(default)]
    pub hooks: Vec<ConfiguredHook>,
    #[serde(default)]
    pub problems: Vec<String>,
}

fn unreadable(what: &str, e: serde_json::Error) -> ProgramError {
    ProgramError::CouldNotRun {
        message: format!("the {what} answer is not what this version reads: {e}"),
    }
}

impl Program {
    /// Reads the ledger of `change`: what ran on this machine, per repository.
    pub fn status(&self, place: &Place, change: &str) -> Result<Status, ProgramError> {
        let answer = self.run(&["status", "--json", "--change", change], place)?;
        serde_json::from_value(answer).map_err(|e| unreadable("status", e))
    }

    /// Reads the hooks of `system` as committed on the master's base branch, for one `event` when given.
    pub fn hooks(
        &self,
        place: &Place,
        system: &str,
        event: Option<&str>,
    ) -> Result<Hooks, ProgramError> {
        let mut command = vec!["hooks", "--json", "--system", system];
        if let Some(event) = event {
            command.extend(["--event", event]);
        }
        let answer = self.run(&command, place)?;
        serde_json::from_value(answer).map_err(|e| unreadable("hooks", e))
    }
}

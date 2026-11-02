//! What Kata saved about a change's pull requests in `pull-requests.json`, before the ai-sdlc program recorded
//! them in `change.yml`. Kata only reads it now: `pull_requests::view` shows it for a change an earlier version
//! declared done. Kata keeps no credential here.
use serde::{Deserialize, Serialize};

/// A pull request's last-known state.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum PrStateKind {
    Open,
    Merged,
    Closed,
}

/// One repository's pull request, as last seen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrEntry {
    pub repo: String,
    pub url: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub number: u64,
    /// The branch the pull request was opened from; a record saved before branches could be
    /// renamed has none, and `store::load_pr_records` reads it as `change/<change>`.
    #[serde(default)]
    pub branch: String,
    /// The commit the change branch was pushed at.
    pub pushed_head: String,
    pub state: PrStateKind,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub seen_at: u64,
}

/// What `pull-requests.json` keeps for one change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PrRecord {
    pub workspace_id: String,
    pub system: String,
    pub change: String,
    /// When every touched repository had an entry; none while the set is partial.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub declared_at: Option<u64>,
    pub repos: Vec<PrEntry>,
    /// Pull requests opened under a branch name the change no longer uses. Kata lists them so the
    /// engineer can close them by hand; it never closes them.
    #[serde(default)]
    pub left_behind: Vec<PrEntry>,
}

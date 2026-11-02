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

impl PrRecord {
    /// A record with no pull request yet.
    pub fn new(workspace_id: &str, system: &str, change: &str) -> Self {
        PrRecord {
            workspace_id: workspace_id.into(),
            system: system.into(),
            change: change.into(),
            declared_at: None,
            repos: Vec::new(),
            left_behind: Vec::new(),
        }
    }

    /// Move every entry opened from a branch other than `current_branch` into `left_behind`, and
    /// clear `declared_at` when any moved: the change is no longer declared under its new name.
    pub fn retire(&mut self, current_branch: &str) {
        let (keep, moved): (Vec<PrEntry>, Vec<PrEntry>) = std::mem::take(&mut self.repos)
            .into_iter()
            .partition(|e| e.branch == current_branch);
        self.repos = keep;
        if !moved.is_empty() {
            self.declared_at = None;
            self.left_behind.extend(moved);
        }
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The number at the end of a pull request URL.
pub fn pull_number(url: &str) -> u64 {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(repo: &str, state: PrStateKind, seen_at: u64) -> PrEntry {
        PrEntry {
            repo: repo.into(),
            url: format!("https://github.com/o/{repo}/pull/1"),
            number: 1,
            branch: "change/c".into(),
            pushed_head: format!("head-{repo}"),
            state,
            seen_at,
        }
    }

    fn record(entries: &[PrEntry], declared: bool) -> PrRecord {
        PrRecord {
            workspace_id: "w1".into(),
            system: "s".into(),
            change: "c".into(),
            declared_at: declared.then_some(50),
            repos: entries.to_vec(),
            left_behind: Vec::new(),
        }
    }

    #[test]
    fn retire_moves_old_entries() {
        let on = |repo: &str, branch: &str| PrEntry {
            branch: branch.into(),
            ..entry(repo, PrStateKind::Open, 7)
        };
        let mut rec = record(
            &[
                on("api", "feat/old"),
                on("kata", "feat/old"),
                on("m", "feat/new"),
            ],
            true,
        );
        rec.retire("feat/new");
        assert_eq!(rec.repos, vec![on("m", "feat/new")]);
        assert_eq!(
            rec.left_behind,
            vec![on("api", "feat/old"), on("kata", "feat/old")]
        );
        assert_eq!(rec.declared_at, None);

        // Nothing to retire leaves a declared change declared.
        let mut same = record(&[on("m", "feat/new")], true);
        same.retire("feat/new");
        assert_eq!(same.declared_at, Some(50));
        assert!(same.left_behind.is_empty());
    }
}

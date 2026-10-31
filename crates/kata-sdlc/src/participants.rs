//! Who takes part in a build: the one answer to which repositories are in it, where each is checked
//! out, and which uncommitted files each one owns. Starting a build, continuing a stopped run and
//! listing what a run left behind all read it; none of them keeps its own list.
use crate::branch::branch_exists;
use crate::build::{self, BuildStatus, RepoState};
use crate::changes::{is_change_name, is_safe_system};
use crate::snapshot::{build_log_owner, dirty_files};
use crate::start::{recorded_branch, refuse, BuildError};
use crate::workspace::{self, system_repos};
use serde::Serialize;
use std::collections::BTreeMap;
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

/// Every repository that takes part in the change's build: the master first, then each repository
/// the plan names (finished or not), then each of `pending`, the repositories a run is about to
/// start in on the engineer's ask (a round, or Continue), that the plan does not name, in the order
/// given and each once. Reads, never changes.
pub fn participants(
    plugin: &Path,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
    pending: &[String],
) -> Result<Vec<Participant>, BuildError> {
    Ok(model(plugin, folder, master_repo, system, change, pending)?.0)
}

/// The product repositories taking part in the change's build that lack the change's recorded
/// branch (`change/<change>` when it has no record). No other name is searched for. The Changes view lists only repositories with that branch, so it names these rather
/// than leaving them out without a word.
pub fn missing_change_branches(
    plugin: &Path,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
) -> Result<Vec<String>, BuildError> {
    let branch = recorded_branch(&folder.join(master_repo), system, change)?;
    Ok(
        participants(plugin, folder, master_repo, system, change, &[])?
            .into_iter()
            .filter(|p| !p.master && !branch_exists(Path::new(&p.path), &branch))
            .map(|p| p.repo)
            .collect(),
    )
}

/// The participants together with the build status they were read against.
pub(crate) fn model(
    plugin: &Path,
    folder: &Path,
    master_repo: &str,
    system: &str,
    change: &str,
    pending: &[String],
) -> Result<(Vec<Participant>, BuildStatus), BuildError> {
    if !is_safe_system(master_repo) || !is_safe_system(system) || !is_change_name(change) {
        return refuse(format!(
            "invalid master repository, system or change name: {master_repo}, {system}, {change}"
        ));
    }
    let master = folder.join(master_repo);
    let status = build::status(plugin, &master, system, change)?;
    let scan = workspace::scan(folder)?;
    let in_system = system_repos(&scan, system);

    let mut names: Vec<(&str, bool)> = status
        .repos
        .iter()
        .filter(|r| r.repo != master_repo)
        .map(|r| (r.repo.as_str(), true))
        .collect();
    for p in pending {
        if p != master_repo && !names.iter().any(|(n, _)| *n == p) {
            names.push((p, false));
        }
    }
    let mut taking_part = Vec::new();
    for (name, planned) in names {
        let who = if planned {
            format!("the plan names {name}")
        } else {
            format!("the round names {name}")
        };
        let problem = if !is_safe_system(name) {
            Some("which is not a valid repository name".to_string())
        } else if !in_system.iter().any(|r| r == name) {
            Some(format!("which is not in system {system}"))
        } else if !scan.repos.iter().any(|r| r == name) {
            Some("which is not checked out in this workspace".to_string())
        } else {
            None
        };
        let finished = status
            .repos
            .iter()
            .any(|r| r.repo == name && r.state == RepoState::Done);
        match problem {
            // A repository whose tasks are all done needs nothing from this workspace, unless a round
            // is about to run in it: that run needs the checkout.
            Some(_) if finished && !pending.iter().any(|p| p == name) => {}
            Some(why) => return refuse(format!("{who}, {why}")),
            None => taking_part.push(name),
        }
    }

    let mut master_files = Vec::new();
    let mut rows: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for path in dirty_files(&master)? {
        match build_log_owner(&path, system, change) {
            Some(owner) => rows.entry(owner.to_string()).or_default().push(path),
            None => master_files.push(path),
        }
    }

    let mut out = Vec::new();
    let take_rows = |rows: &mut BTreeMap<String, Vec<String>>, repo: &str| {
        rows.remove(repo).unwrap_or_default()
    };
    out.push(Participant {
        repo: master_repo.to_string(),
        path: master.to_string_lossy().into_owned(),
        master: true,
        files: master_files,
        rows: take_rows(&mut rows, master_repo),
    });
    for name in taking_part {
        let path = folder.join(name);
        out.push(Participant {
            repo: name.to_string(),
            files: dirty_files(&path)?,
            path: path.to_string_lossy().into_owned(),
            master: false,
            rows: take_rows(&mut rows, name),
        });
    }
    // A log whose repository is not in the build still sits in the master's tree: the master holds it.
    out[0].rows.extend(rows.into_values().flatten());
    Ok((out, status))
}

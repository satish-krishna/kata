use crate::{frontmatter, git};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const MARKER: &str = ".ai-sdlc.json";

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("cannot read workspace folder: {0}")]
    Io(#[from] std::io::Error),
}

/// The `.ai-sdlc.json` marker (ai-sdlc `references/workspace.md` section 3).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Marker {
    pub version: u32,
    #[serde(default)]
    pub systems: BTreeMap<String, SystemDef>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct SystemDef {
    #[serde(default)]
    pub repos: Vec<String>,
    /// The Conventional Commits scope for this system's commits; the system name when absent.
    #[serde(
        rename = "commitScope",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(optional = nullable, rename = "commitScope"))]
    pub commit_scope: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum MasterState {
    None,
    One { repo: String, committed: bool },
    Many { repos: Vec<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceScan {
    pub folder: String,
    pub repos: Vec<String>,
    pub master: MasterState,
    pub marker: Option<Marker>,
    pub marker_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ContextState {
    Fresh,
    Stale { commits: u32 },
    Missing,
    NotCheckedOut,
}

/// "Committed": tracked by git and clean in the working tree.
pub fn is_committed(repo: &Path, rel: &str) -> bool {
    git::run(repo, &["ls-files", "--error-unmatch", "--", rel]).is_ok()
        && git::run(repo, &["status", "--porcelain", "--", rel])
            .map(|out| out.is_empty())
            .unwrap_or(false)
}

/// Scan a workspace folder: immediate child git repos, the master, and the marker.
pub fn scan(folder: &Path) -> Result<WorkspaceScan, ScanError> {
    let mut repos = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        if entry.path().is_dir() && entry.path().join(".git").exists() {
            repos.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    repos.sort();

    let masters: Vec<String> = repos
        .iter()
        .filter(|r| folder.join(r).join(MARKER).is_file())
        .cloned()
        .collect();

    let mut marker = None;
    let mut marker_error = None;
    let master = match masters.as_slice() {
        [] => MasterState::None,
        [one] => {
            let path = folder.join(one);
            match std::fs::read_to_string(path.join(MARKER)) {
                Ok(text) => match serde_json::from_str::<Marker>(&text) {
                    Ok(m) => marker = Some(m),
                    Err(e) => marker_error = Some(e.to_string()),
                },
                Err(e) => marker_error = Some(e.to_string()),
            }
            MasterState::One {
                repo: one.clone(),
                committed: is_committed(&path, MARKER),
            }
        }
        many => MasterState::Many {
            repos: many.to_vec(),
        },
    };

    Ok(WorkspaceScan {
        folder: folder.to_string_lossy().into_owned(),
        repos,
        master,
        marker,
        marker_error,
    })
}

/// The repos of `system`: the marker's list, or every repo except the master when empty or missing.
pub fn system_repos(scan: &WorkspaceScan, system: &str) -> Vec<String> {
    let listed = scan
        .marker
        .as_ref()
        .and_then(|m| m.systems.get(system))
        .map(|s| s.repos.clone())
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    let master = match &scan.master {
        MasterState::One { repo, .. } => Some(repo.as_str()),
        _ => None,
    };
    scan.repos
        .iter()
        .filter(|r| Some(r.as_str()) != master)
        .cloned()
        .collect()
}

/// How current `intent/<system>/context/<repo>.md` is against the repo's product commits.
pub fn context_health(folder: &Path, master: &str, system: &str, repo: &str) -> ContextState {
    let repo_dir = folder.join(repo);
    if !repo_dir.is_dir() {
        return ContextState::NotCheckedOut;
    }
    let file = folder
        .join(master)
        .join("intent")
        .join(system)
        .join("context")
        .join(format!("{repo}.md"));
    let Ok(text) = std::fs::read_to_string(&file) else {
        return ContextState::Missing;
    };
    let Some(sha) = frontmatter::field(&text, "source_commit").filter(|s| !s.is_empty()) else {
        return ContextState::Stale { commits: 0 };
    };
    let range = format!("{sha}..HEAD");
    let counted = git::run(
        &repo_dir,
        &[
            "rev-list",
            "--count",
            &range,
            "--",
            ".",
            ":(exclude)intent",
            ":(exclude).ai-sdlc.json",
        ],
    )
    .ok()
    .and_then(|out| out.trim().parse::<u32>().ok());
    match counted {
        Some(0) => ContextState::Fresh,
        Some(n) => ContextState::Stale { commits: n },
        None => ContextState::Stale { commits: 0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{commit_file, repo};

    fn bare_repo(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join(name).join(".git")).unwrap();
    }

    #[test]
    fn scan_finds_immediate_repos_only() {
        let tmp = tempfile::tempdir().unwrap();
        bare_repo(tmp.path(), "a");
        bare_repo(tmp.path(), "b");
        bare_repo(&tmp.path().join("c"), "deep");
        std::fs::create_dir(tmp.path().join("d")).unwrap();
        assert_eq!(scan(tmp.path()).unwrap().repos, vec!["a", "b"]);
    }

    #[test]
    fn scan_handles_spaces_in_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("my work");
        std::fs::create_dir(&ws).unwrap();
        repo(&ws, "svc");
        assert_eq!(scan(&ws).unwrap().repos, vec!["svc"]);
    }

    #[test]
    fn master_none_one_many() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(tmp.path(), "a");
        let b = repo(tmp.path(), "b");
        assert_eq!(scan(tmp.path()).unwrap().master, MasterState::None);

        std::fs::write(a.join(MARKER), r#"{"version":1,"systems":{}}"#).unwrap();
        assert_eq!(
            scan(tmp.path()).unwrap().master,
            MasterState::One {
                repo: "a".into(),
                committed: false
            }
        );

        commit_file(&a, MARKER, r#"{"version":1,"systems":{}}"#, "marker");
        assert_eq!(
            scan(tmp.path()).unwrap().master,
            MasterState::One {
                repo: "a".into(),
                committed: true
            }
        );

        std::fs::write(b.join(MARKER), "{}").unwrap();
        assert_eq!(
            scan(tmp.path()).unwrap().master,
            MasterState::Many {
                repos: vec!["a".into(), "b".into()]
            }
        );
    }

    #[test]
    fn unborn_head_marker_is_not_committed() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        std::fs::create_dir(&a).unwrap();
        git::run(&a, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(a.join(MARKER), r#"{"version":1}"#).unwrap();
        assert_eq!(
            scan(tmp.path()).unwrap().master,
            MasterState::One {
                repo: "a".into(),
                committed: false
            }
        );
    }

    #[test]
    fn malformed_marker_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(tmp.path(), "a");
        std::fs::write(a.join(MARKER), "{").unwrap();
        let s = scan(tmp.path()).unwrap();
        assert!(s.marker.is_none());
        assert!(s.marker_error.is_some());
    }

    #[test]
    fn system_repos_defaults_to_all_but_master() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(tmp.path(), "a");
        repo(tmp.path(), "b");
        repo(tmp.path(), "c");
        std::fs::write(
            a.join(MARKER),
            r#"{"version":1,"systems":{"x":{"repos":["c"]},"y":{}}}"#,
        )
        .unwrap();
        let s = scan(tmp.path()).unwrap();
        assert_eq!(system_repos(&s, "x"), vec!["c"]);
        assert_eq!(system_repos(&s, "y"), vec!["b", "c"]);
        assert_eq!(system_repos(&s, "nope"), vec!["b", "c"]);
    }

    #[test]
    fn context_states() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let master = repo(ws, "m");
        let svc = repo(ws, "svc");
        assert_eq!(context_health(ws, "m", "sys", "svc"), ContextState::Missing);

        let sha = git::run(&svc, &["rev-parse", "HEAD"]).unwrap();
        let ctx = format!("---\nrepo: svc\nsource_commit: {sha}\n---\nbody\n");
        commit_file(&master, "intent/sys/context/svc.md", &ctx, "ctx");
        assert_eq!(context_health(ws, "m", "sys", "svc"), ContextState::Fresh);

        commit_file(&svc, "src.rs", "x", "product");
        assert_eq!(
            context_health(ws, "m", "sys", "svc"),
            ContextState::Stale { commits: 1 }
        );

        // Master listing itself: an intent-only commit does not stale its own context.
        let msha = git::run(&master, &["rev-parse", "HEAD"]).unwrap();
        let mctx = format!("---\nrepo: m\nsource_commit: {msha}\n---\n");
        commit_file(&master, "intent/sys/context/m.md", &mctx, "ctx m");
        assert_eq!(context_health(ws, "m", "sys", "m"), ContextState::Fresh);

        std::fs::remove_dir_all(&svc).unwrap();
        assert_eq!(
            context_health(ws, "m", "sys", "svc"),
            ContextState::NotCheckedOut
        );
    }

    #[test]
    fn unknown_sha_is_stale_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let master = repo(tmp.path(), "m");
        repo(tmp.path(), "svc");
        commit_file(
            &master,
            "intent/sys/context/svc.md",
            "---\nsource_commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n---\n",
            "ctx",
        );
        assert_eq!(
            context_health(tmp.path(), "m", "sys", "svc"),
            ContextState::Stale { commits: 0 }
        );
    }
}

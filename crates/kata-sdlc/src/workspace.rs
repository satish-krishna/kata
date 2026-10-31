use crate::changes::is_safe_system;
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
    /// The team's naming setting, kept as the marker holds it: the format program is the one place that
    /// reads it, this field only keeps a scan from dropping it when the marker is written back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub naming: Option<serde_json::Value>,
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

/// Whether this machine's copy of the workspace instructions matches the master's `intent/workspace.md`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum InstructionsState {
    Missing,
    OutOfDate,
    Current,
}

/// "Committed": tracked by git and clean in the working tree.
pub fn is_committed(repo: &Path, rel: &str) -> bool {
    git::Repo::open(repo).is_ok_and(|r| r.is_committed(rel))
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
    let counted = git::Repo::open(&repo_dir)
        .and_then(|r| r.count_since(&sha, &["."], &["intent", ".ai-sdlc.json"]))
        .ok();
    match counted {
        Some(0) => ContextState::Fresh,
        Some(n) => ContextState::Stale { commits: n },
        None => ContextState::Stale { commits: 0 },
    }
}

/// The text of `intent/<system>/context/<repo>.md` in the master, for the Workbench's context viewer. `None` for
/// a system or repo name that is not one plain folder name, or a file that is not there. Reads only.
pub fn read_context(master: &Path, system: &str, repo: &str) -> Option<String> {
    if !is_safe_system(system) || !is_safe_system(repo) {
        return None;
    }
    std::fs::read_to_string(
        master
            .join("intent")
            .join(system)
            .join("context")
            .join(format!("{repo}.md")),
    )
    .ok()
}

/// The state of `<workspace>/CLAUDE.md` against `<master>/intent/workspace.md` (ai-sdlc `references/workspace.md` section 2). Reads only.
pub fn instructions(workspace: &Path, master: &Path) -> InstructionsState {
    let Ok(expected) = std::fs::read_to_string(master.join("intent").join("workspace.md")) else {
        return InstructionsState::Missing;
    };
    let Ok(claude) = std::fs::read_to_string(workspace.join("CLAUDE.md")) else {
        return InstructionsState::OutOfDate;
    };
    match block_text(&claude) {
        Some(copy) if normalize(&copy) == normalize(&expected) => InstructionsState::Current,
        _ => InstructionsState::OutOfDate,
    }
}

const START_MARKER: &str = "<!-- ai-sdlc:start -->";
const END_MARKER: &str = "<!-- ai-sdlc:end -->";
const GENERATED_PREFIX: &str = "<!-- generated by ai-sdlc setup";

/// The text of the block after its generated line, when the file has exactly one start marker line before exactly one end marker line.
fn block_text(claude: &str) -> Option<String> {
    let lines: Vec<&str> = claude.lines().collect();
    let at = |marker: &str| -> Vec<usize> {
        lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.trim() == marker)
            .map(|(i, _)| i)
            .collect()
    };
    let (starts, ends) = (at(START_MARKER), at(END_MARKER));
    let ([start], [end]) = (starts.as_slice(), ends.as_slice()) else {
        return None;
    };
    if start >= end {
        return None;
    }
    let inside = &lines[start + 1..*end];
    let rest = match inside.first() {
        Some(first) if first.trim_start().starts_with(GENERATED_PREFIX) => &inside[1..],
        _ => inside,
    };
    Some(rest.join("\n"))
}

/// Line endings as LF, trailing whitespace trimmed per line, blank lines dropped at both ends.
fn normalize(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let first = lines.iter().position(|l| !l.is_empty());
    let last = lines.iter().rposition(|l| !l.is_empty());
    match (first, last) {
        (Some(a), Some(b)) => lines[a..=b].join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{commit_file, repo};

    const WS_TEXT: &str = "# ai-sdlc workspace\n\nRules here.\n";
    const GEN: &str =
        "<!-- generated by ai-sdlc setup from m/intent/workspace.md; edit outside this block -->";

    fn instr_setup(workspace_md: Option<&str>, claude_md: Option<&str>) -> InstructionsState {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let master = ws.join("m");
        std::fs::create_dir_all(master.join("intent")).unwrap();
        if let Some(t) = workspace_md {
            std::fs::write(master.join("intent").join("workspace.md"), t).unwrap();
        }
        if let Some(t) = claude_md {
            std::fs::write(ws.join("CLAUDE.md"), t).unwrap();
        }
        instructions(&ws, &master)
    }

    fn block(body: &str) -> String {
        format!("<!-- ai-sdlc:start -->\n{GEN}\n{body}<!-- ai-sdlc:end -->\n")
    }

    #[test]
    fn instructions_missing_when_workspace_md_is_missing() {
        assert_eq!(instr_setup(None, None), InstructionsState::Missing);
        assert_eq!(
            instr_setup(None, Some(&block(WS_TEXT))),
            InstructionsState::Missing
        );
    }

    #[test]
    fn instructions_out_of_date_when_claude_md_is_missing() {
        assert_eq!(
            instr_setup(Some(WS_TEXT), None),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_out_of_date_when_there_is_no_block() {
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some("my own notes\n")),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_out_of_date_when_text_differs() {
        assert_eq!(
            instr_setup(
                Some(WS_TEXT),
                Some(&block("# ai-sdlc workspace\n\nOld rules.\n"))
            ),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_current_when_text_equals() {
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&block(WS_TEXT))),
            InstructionsState::Current
        );
    }

    #[test]
    fn instructions_current_with_crlf_and_trailing_blank_lines() {
        let claude = format!(
            "<!-- ai-sdlc:start -->\r\n{GEN}\r\n# ai-sdlc workspace  \r\n\r\nRules here.\r\n\r\n\r\n<!-- ai-sdlc:end -->\r\n"
        );
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&claude)),
            InstructionsState::Current
        );
    }

    #[test]
    fn instructions_out_of_date_with_the_start_marker_twice() {
        let claude = format!("<!-- ai-sdlc:start -->\n{}", block(WS_TEXT));
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&claude)),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_out_of_date_with_the_end_before_the_start() {
        let claude = format!("<!-- ai-sdlc:end -->\n<!-- ai-sdlc:start -->\n{GEN}\n{WS_TEXT}");
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&claude)),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_ignore_notes_outside_the_block() {
        let claude = format!("my notes\n\n{}\nmore notes\n", block(WS_TEXT));
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&claude)),
            InstructionsState::Current
        );
        let stale = format!("my notes\n{}more notes\n", block("old\n"));
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&stale)),
            InstructionsState::OutOfDate
        );
    }

    #[test]
    fn instructions_marker_lines_are_trimmed() {
        let claude =
            format!("  <!-- ai-sdlc:start -->  \n{GEN}\n{WS_TEXT}\t<!-- ai-sdlc:end -->\n");
        assert_eq!(
            instr_setup(Some(WS_TEXT), Some(&claude)),
            InstructionsState::Current
        );
    }

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

    #[test]
    fn read_context_reads_the_file_and_refuses_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let master = repo(tmp.path(), "m");
        assert_eq!(read_context(&master, "sys", "svc"), None);
        commit_file(
            &master,
            "intent/sys/context/svc.md",
            "---\nrepo: svc\n---\n# svc\n",
            "ctx",
        );
        assert_eq!(
            read_context(&master, "sys", "svc").as_deref(),
            Some("---\nrepo: svc\n---\n# svc\n")
        );
        assert_eq!(read_context(&master, "sys", "../context/svc"), None);
        assert_eq!(read_context(&master, "..", "svc"), None);
        assert_eq!(read_context(&master, "sys/../sys", "svc"), None);
    }
}

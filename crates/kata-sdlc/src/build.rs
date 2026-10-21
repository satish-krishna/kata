//! The build's state, read from the plan and the build logs as committed in the master
//! repository. Nothing in Kata parses `plan.md` or `build/<repo>.md` itself: the ai-sdlc plugin's
//! format program reads them, in either layout, and this module folds its answer into a status.
use crate::format::{self, FormatError, ParsedBuildLog, ParsedTask, Problem, ReadResult};
use crate::git::{self, GitError};
use crate::plugin::Readiness;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One task of the plan.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct PlanTask {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub depends_on: Vec<String>,
}

/// One row of a build log: a task recorded as finished.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildRow {
    pub task: String,
    pub repo: String,
    pub commits: Vec<String>,
    pub departure: Option<String>,
}

/// Where a repository stands in the build.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum RepoState {
    Ready {
        task: String,
    },
    Waiting {
        task: String,
        on_task: String,
        on_repo: String,
    },
    Done,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct TaskStatus {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub depends_on: Vec<String>,
    /// The task's own section of the plan, as the format program parsed it.
    pub text: String,
    pub row: Option<BuildRow>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RepoStatus {
    pub repo: String,
    pub first_unfinished: Option<String>,
    pub state: RepoState,
    pub tasks: u32,
    pub finished: u32,
}

/// A task whose row records a departure, with what the plan said for it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Departure {
    pub task: String,
    pub repo: String,
    pub plan_text: String,
    pub departure: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildStatus {
    pub tasks: Vec<TaskStatus>,
    pub repos: Vec<RepoStatus>,
    pub departures: Vec<Departure>,
    pub has_tasks: bool,
    /// Everything the format program found wrong in the plan and the build logs.
    pub problems: Vec<Problem>,
    /// The layout each build log is written in, so the Build tab can label an older one.
    pub log_layouts: Vec<LogLayout>,
}

/// The layout one build log is written in.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct LogLayout {
    pub repo: String,
    pub layout: u32,
}

/// Rows a build log holds in the working tree and not yet in `HEAD`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct UnsavedRows {
    pub repo: String,
    pub tasks: Vec<String>,
}

pub(crate) fn change_dir(system: &str, change: &str) -> String {
    format!("intent/{system}/{change}")
}

const FORMAT_PROGRAM: &str = "ai-sdlc format program";

/// True when `error` came from the format program (it could not run or could not read), not from git.
pub(crate) fn is_unreadable(error: &GitError) -> bool {
    error.args == FORMAT_PROGRAM
}

/// A format-program failure reported the way a git failure is, so one error type serves both.
pub(crate) fn unreadable(error: FormatError) -> GitError {
    GitError {
        args: FORMAT_PROGRAM.into(),
        stderr: error.to_string(),
    }
}

/// The format program inside the ai-sdlc plugin folder.
pub(crate) fn program(plugin: &Path) -> PathBuf {
    plugin.join("format").join("check.mjs")
}

/// Where the committed documents are put for the program to read: the program takes a document's
/// kind from its path, so each change keeps one stable folder (which `reading` locks).
pub(crate) fn staging_dir(master: &Path, system: &str, change: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    master
        .canonicalize()
        .unwrap_or_else(|_| master.to_path_buf())
        .hash(&mut hasher);
    (system, change).hash(&mut hasher);
    std::env::temp_dir()
        .join("kata-format-read")
        .join(format!("{:016x}", hasher.finish()))
}

pub(crate) fn put(path: &Path, text: &str) -> Result<(), GitError> {
    if std::fs::read_to_string(path).is_ok_and(|have| have == text) {
        return Ok(());
    }
    let write = || -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, text)
    };
    write().map_err(|e| GitError {
        args: path.display().to_string(),
        stderr: e.to_string(),
    })
}

/// The file stem of a build log path: the repository it logs.
fn log_repo(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
}

/// The committed plan and build logs, parsed by the format program, with every problem it found.
struct Committed {
    tasks: Vec<ParsedTask>,
    logs: Vec<ParsedBuildLog>,
    plan_layout: u32,
    plan_problems: Vec<Problem>,
    /// The layout of each build log, in the order of `logs`.
    log_layouts: Vec<u32>,
    log_problems: Vec<Problem>,
}

impl Committed {
    /// Every problem in the plan, then every problem in the build logs.
    fn problems(&self) -> Vec<Problem> {
        let mut all = self.plan_problems.clone();
        all.extend(self.log_problems.iter().cloned());
        all
    }
}

/// The text of `path` as committed at `HEAD`; `None` when `HEAD` does not hold it.
fn committed_file(master: &Path, path: &str) -> Result<Option<String>, GitError> {
    if git::run(master, &["ls-tree", "--name-only", "HEAD", "--", path])?.is_empty() {
        return Ok(None);
    }
    git::run(master, &["show", &format!("HEAD:{path}")]).map(Some)
}

/// Writes `text` to `file`, or removes `file` when there is none.
fn stage_or_remove(file: &Path, text: Option<&str>) {
    match text {
        Some(text) => {
            let _ = put(file, text);
        }
        None => {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// The lock for one staging folder: the staged files are shared by every read of the same change, so
/// those take turns, while the reads of other changes go on beside them.
pub(crate) fn reading(stage: &Path) -> Arc<Mutex<()>> {
    static LOCKS: Mutex<Vec<(PathBuf, Arc<Mutex<()>>)>> = Mutex::new(Vec::new());
    let mut locks = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, lock)) = locks.iter().find(|(path, _)| path == stage) {
        return lock.clone();
    }
    let lock = Arc::new(Mutex::new(()));
    locks.push((stage.to_path_buf(), lock.clone()));
    lock
}

/// Reads the plan and every build log as committed at `HEAD` (never the working tree) through the
/// format program, whatever layout each is written in. A review log is not a build log.
fn read_committed(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
) -> Result<Committed, GitError> {
    let dir = format!("{}/build/", change_dir(system, change));
    let plan = git::run(
        master,
        &[
            "show",
            &format!("HEAD:{}/plan.md", change_dir(system, change)),
        ],
    )?;
    let listing = git::run(
        master,
        &["ls-tree", "-z", "--name-only", "HEAD", "--", &dir],
    )?;
    let mut paths: Vec<&str> = listing
        .split('\0')
        .filter(|p| p.ends_with(".md") && log_repo(p) != "review")
        .collect();
    paths.sort_unstable();
    let texts: Vec<(&str, String)> = paths
        .into_iter()
        .map(|p| Ok((p, git::run(master, &["show", &format!("HEAD:{p}")])?)))
        .collect::<Result<_, GitError>>()?;

    let spec = committed_file(master, &format!("{}/spec.md", change_dir(system, change)))?;
    let marker = committed_file(master, crate::workspace::MARKER)?;

    let stage = staging_dir(master, system, change);
    let lock = reading(&stage);
    let _one_reader = lock.lock().unwrap_or_else(|e| e.into_inner());
    put(&stage.join("plan.md"), &plan)?;
    // The spec lets the check find a task covering something the spec does not hold; the marker, which the
    // program finds by walking up from the plan, lets it find a repository the system does not list.
    stage_or_remove(&stage.join("spec.md"), spec.as_deref());
    stage_or_remove(&stage.join(crate::workspace::MARKER), marker.as_deref());
    let build = stage.join("build");
    for (path, text) in &texts {
        put(&build.join(format!("{}.md", log_repo(path))), text)?;
    }
    if let Ok(left) = std::fs::read_dir(&build) {
        for entry in left.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !texts
                .iter()
                .any(|(p, _)| format!("{}.md", log_repo(p)) == name)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let program = program(plugin);
    let read_plan = format::read(&program, &stage.join("plan.md")).map_err(unreadable)?;
    let plan_problems = read_plan.problems().to_vec();
    let plan_layout = read_plan.layout();
    let ReadResult::Plan { document, .. } = read_plan else {
        return Err(unreadable(FormatError::BadOutput(
            "plan.md was not read as a plan".into(),
        )));
    };
    let mut plan_problems = plan_problems;
    let mut logs = Vec::new();
    let mut log_layouts = Vec::new();
    let mut log_problems = Vec::new();
    for (path, _) in &texts {
        let file = build.join(format!("{}.md", log_repo(path)));
        let read_log = format::read(&program, &file).map_err(unreadable)?;
        log_problems.extend(read_log.problems().iter().cloned());
        log_layouts.push(read_log.layout());
        let ReadResult::BuildLog { document, .. } = read_log else {
            return Err(unreadable(FormatError::BadOutput(format!(
                "{path} was not read as a build log"
            ))));
        };
        logs.push(document);
    }
    // A document in a layout this Workbench cannot read is refused by the gate before anything else, and
    // the checks across documents mean nothing for it.
    let readable = std::iter::once(&plan_layout)
        .chain(&log_layouts)
        .all(|l| format::ACCEPTED_LAYOUTS.contains(l));
    if readable {
        let mut documents = vec!["plan.md".to_string()];
        if spec.is_some() {
            documents.push("spec.md".into());
        }
        documents.extend(
            texts
                .iter()
                .map(|(p, _)| format!("build/{}.md", log_repo(p))),
        );
        let documents: Vec<&str> = documents.iter().map(String::as_str).collect();
        // The check repeats every problem a document has on its own, so it replaces what the reads found.
        let found = format::check_change(&program, &stage, &documents).map_err(unreadable)?;
        (log_problems, plan_problems) = found
            .into_iter()
            .partition(|p| p.file.starts_with("build/"));
    }
    Ok(Committed {
        tasks: document.tasks,
        logs,
        plan_layout,
        plan_problems,
        log_layouts,
        log_problems,
    })
}

fn rows_of(logs: &[ParsedBuildLog]) -> Vec<BuildRow> {
    logs.iter()
        .flat_map(|log| {
            log.entries.iter().map(|entry| BuildRow {
                task: entry.task.clone(),
                repo: log.repo.clone(),
                commits: entry.commits.clone(),
                departure: entry.departure.clone().filter(|d| !d.trim().is_empty()),
            })
        })
        .collect()
}

/// Every build log row as committed at `HEAD` (never the working tree).
pub fn committed_rows(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
) -> Result<Vec<BuildRow>, GitError> {
    Ok(rows_of(
        &read_committed(plugin, master, system, change)?.logs,
    ))
}

/// The build's state from the plan and build logs committed at `HEAD`, read by the format program
/// in `plugin` (the ai-sdlc plugin folder). Problems found in those documents come back in
/// `problems` and do not stop the reading.
pub fn status(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
) -> Result<BuildStatus, GitError> {
    let committed = read_committed(plugin, master, system, change)?;
    let rows = rows_of(&committed.logs);
    let row_of = |id: &str| rows.iter().find(|r| r.task == id);

    let tasks: Vec<TaskStatus> = committed
        .tasks
        .iter()
        .map(|t| TaskStatus {
            id: t.id.clone(),
            name: t.name.clone(),
            repo: t.repo.clone(),
            depends_on: t.depends_on.clone(),
            text: t.text.clone(),
            row: row_of(&t.id).cloned(),
        })
        .collect();

    let mut names: Vec<&str> = Vec::new();
    for t in &tasks {
        if !names.contains(&t.repo.as_str()) {
            names.push(&t.repo);
        }
    }
    let repos = names
        .into_iter()
        .map(|repo| {
            let mine: Vec<&TaskStatus> = tasks.iter().filter(|t| t.repo == repo).collect();
            let first = mine.iter().find(|t| t.row.is_none());
            let state = match first {
                None => RepoState::Done,
                Some(t) => match t.depends_on.iter().find(|d| row_of(d).is_none()) {
                    None => RepoState::Ready { task: t.id.clone() },
                    Some(dep) => RepoState::Waiting {
                        task: t.id.clone(),
                        on_task: dep.clone(),
                        on_repo: tasks
                            .iter()
                            .find(|o| &o.id == dep)
                            .map(|o| o.repo.clone())
                            .unwrap_or_default(),
                    },
                },
            };
            RepoStatus {
                repo: repo.to_string(),
                first_unfinished: first.map(|t| t.id.clone()),
                state,
                tasks: mine.len() as u32,
                finished: mine.iter().filter(|t| t.row.is_some()).count() as u32,
            }
        })
        .collect();

    let departures = tasks
        .iter()
        .filter_map(|t| {
            let row = t.row.as_ref()?;
            Some(Departure {
                task: t.id.clone(),
                repo: row.repo.clone(),
                plan_text: t.text.clone(),
                departure: row.departure.clone()?,
            })
        })
        .collect();

    Ok(BuildStatus {
        has_tasks: !tasks.is_empty(),
        tasks,
        repos,
        departures,
        problems: committed.problems(),
        log_layouts: committed
            .logs
            .iter()
            .zip(&committed.log_layouts)
            .map(|(log, layout)| LogLayout {
                repo: log.repo.clone(),
                layout: *layout,
            })
            .collect(),
    })
}

/// What the engineer asked the build to do. Every action meets the same gate.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum BuildAction {
    Start,
    Continue,
    Round,
}

/// Whether a build may start, continue or run another round.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Gate {
    Admit,
    /// The build does not go on: `message` says why and `problems` lists what the format program
    /// found, when that is the reason.
    Refuse {
        message: String,
        problems: Vec<Problem>,
    },
}

fn refuse(message: impl Into<String>, problems: Vec<Problem>) -> Gate {
    Gate::Refuse {
        message: message.into(),
        problems,
    }
}

/// Decides whether a build may start, continue or run another round, from the plugin and from the
/// plan and build logs committed at `HEAD`. The first reason that applies is the one given: the
/// plugin, then the plan's layout, the plan's problems, the build logs' layout, their problems. A
/// change with no build log yet passes that part.
pub fn gate(
    plugin: &Readiness,
    master: &Path,
    system: &str,
    change: &str,
    _action: BuildAction,
) -> Result<Gate, GitError> {
    let dir = match plugin {
        Readiness::Missing => return Ok(refuse("Install the ai-sdlc plugin", Vec::new())),
        Readiness::TooOld { need, .. } => {
            return Ok(refuse(
                format!("Update the ai-sdlc plugin to {need} or later"),
                Vec::new(),
            ))
        }
        Readiness::Ready { dir, .. } => dir,
    };
    let committed = read_committed(dir, master, system, change)?;
    let newer = |layout: &u32| !format::ACCEPTED_LAYOUTS.contains(layout);
    Ok(if newer(&committed.plan_layout) {
        refuse("This plan needs a newer Workbench", Vec::new())
    } else if !committed.plan_problems.is_empty() {
        refuse("The plan does not pass the check", committed.plan_problems)
    } else if committed.log_layouts.iter().any(newer) {
        refuse("A build log needs a newer Workbench", Vec::new())
    } else if !committed.log_problems.is_empty() {
        refuse(
            "A build log does not pass the check",
            committed.log_problems,
        )
    } else {
        Gate::Admit
    })
}

/// A build log read by the format program: the entries it holds, whatever layout each is in.
fn read_log(program: &Path, file: &Path, shown: &str) -> Result<ParsedBuildLog, GitError> {
    match format::read(program, file).map_err(unreadable)? {
        ReadResult::BuildLog { document, .. } => Ok(document),
        _ => Err(unreadable(FormatError::BadOutput(format!(
            "{shown} was not read as a build log"
        )))),
    }
}

/// Entries compare by what they record; the line they sit on moves when a row is added above them.
fn same_entry(a: &format::ParsedBuildEntry, b: &format::ParsedBuildEntry) -> bool {
    (&a.task, &a.commits, &a.departure) == (&b.task, &b.commits, &b.departure)
}

/// Build log entries written to the working tree and not committed. A log is unsaved when it is
/// untracked, or when the format program reads its working copy as the committed entries followed
/// by added entries, in either layout or both. Any other change to a log is an error naming the
/// file, since the build skill would refuse it.
pub fn unsaved_rows(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
) -> Result<Vec<UnsavedRows>, GitError> {
    let rel_dir = format!("{}/build", change_dir(system, change));
    let Ok(entries) = std::fs::read_dir(master.join(&rel_dir)) else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".md") && log_repo(n) != "review")
        .collect();
    names.sort_unstable();
    let program = program(plugin);
    let mut out = Vec::new();
    for name in names {
        let rel = format!("{rel_dir}/{name}");
        let repo = log_repo(&rel);
        let working = read_log(&program, &master.join(&rel), &rel)?;
        let listed = git::run(master, &["ls-tree", "--name-only", "HEAD", "--", &rel])?;
        let added = if listed.is_empty() {
            &working.entries[..]
        } else {
            let text = git::run(master, &["show", &format!("HEAD:{rel}")])?;
            let committed = {
                let stage = staging_dir(master, system, change);
                let lock = reading(&stage);
                let _one_reader = lock.lock().unwrap_or_else(|e| e.into_inner());
                let file = stage
                    .join("unsaved")
                    .join("build")
                    .join(format!("{repo}.md"));
                put(&file, &text)?;
                read_log(&program, &file, &rel)?
            };
            let n = committed.entries.len();
            let kept = working.entries.len() >= n
                && committed
                    .entries
                    .iter()
                    .zip(&working.entries)
                    .all(|(a, b)| same_entry(a, b));
            if !kept {
                return Err(GitError {
                    args: rel,
                    stderr: "an uncommitted change to a build log other than added entries".into(),
                });
            }
            &working.entries[n..]
        };
        if !listed.is_empty() && added.is_empty() {
            continue;
        }
        out.push(UnsavedRows {
            repo: repo.to_string(),
            tasks: added.iter().map(|e| e.task.clone()).collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::Readiness;
    use crate::testutil;

    const SYS: &str = "claims";
    const CHG: &str = "2026-10-12-fnol";
    const DIR: &str = "intent/claims/2026-10-12-fnol";
    const FIXTURE_PLAN: &str = include_str!("testdata/plan.md");
    const BUILD_LOG: &str = include_str!("testdata/build-log.md");

    /// A plan of `(id, repo, depends-on text)` tasks; `None` writes no `Depends on` line.
    fn plan_with(tasks: &[(&str, &str, Option<&str>)]) -> String {
        let mut out = String::from("---\nstatus: accepted\n---\n\n# Plan: x\n\n## Tasks\n\n");
        for (id, repo, deps) in tasks {
            out.push_str(&format!("### {id}: Do {id} (`{repo}`)\n\n"));
            if let Some(deps) = deps {
                out.push_str(&format!("- **Depends on:** {deps}\n"));
            }
            out.push_str("- **Change:** something\n\n");
        }
        out.push_str("## Order and dependencies\n\nNone.\n");
        out
    }

    fn log_text(repo: &str, rows: &[&str]) -> String {
        let mut out =
            format!("# Build log: {repo}\n\n| Task | Commits | Departure |\n|---|---|---|\n");
        for r in rows {
            out.push_str(r);
            out.push('\n');
        }
        out
    }

    fn master_with(tmp: &Path, plan: &str) -> std::path::PathBuf {
        let master = testutil::repo(tmp, "master");
        testutil::commit_file(&master, &format!("{DIR}/plan.md"), plan, "plan");
        master
    }

    fn commit_log(master: &Path, repo: &str, rows: &[&str]) {
        testutil::commit_file(
            master,
            &format!("{DIR}/build/{repo}.md"),
            &log_text(repo, rows),
            &format!("log {repo}"),
        );
    }

    fn app_tasks() -> String {
        plan_with(&[
            ("T1", "app", Some("none")),
            ("T2", "app", Some("T1")),
            ("T3", "app", Some("T2")),
        ])
    }

    const PART2_PLAN: &str = include_str!("testdata/part2-plan.md");
    const PART2_LOG: &str = include_str!("testdata/part2-build-kata.md");

    /// A layout-2 build log: front matter, then older table rows, then `entries` verbatim.
    fn layout_2_log(table_rows: &[&str], entries: &str) -> String {
        let mut out = String::from(
            "---\nlayout: 2\n---\n\n# Build log: app\n\n| Task | Commits | Departure |\n|---|---|---|\n",
        );
        for r in table_rows {
            out.push_str(r);
            out.push('\n');
        }
        out.push('\n');
        out.push_str(entries);
        out
    }

    #[test]
    fn status_reads_a_layout_1_plan_and_build_log_as_before() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), PART2_PLAN);
        testutil::commit_file(&master, &format!("{DIR}/build/kata.md"), PART2_LOG, "log");
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.tasks.len(), 30);
        assert!(st.tasks.iter().all(|t| t.row.is_some()), "{st:?}");
        assert!(st.repos.iter().all(|r| r.state == RepoState::Done));
        assert_eq!(
            st.log_layouts,
            vec![LogLayout {
                repo: "kata".into(),
                layout: 1
            }]
        );
    }

    #[test]
    fn status_reads_layout_1_and_layout_2_entries_in_one_log() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let log = layout_2_log(
            &["| T1 | `a111111` | none |"],
            "### T2\n\n```yaml\ntask: T2\ncommits: [b222222]\n```\n",
        );
        testutil::commit_file(&master, &format!("{DIR}/build/app.md"), &log, "log app");
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.tasks[0].row.as_ref().unwrap().commits, vec!["a111111"]);
        assert_eq!(st.tasks[1].row.as_ref().unwrap().commits, vec!["b222222"]);
        assert!(st.tasks[2].row.is_none());
        assert_eq!((st.repos[0].tasks, st.repos[0].finished), (3, 2));
        assert_eq!(st.log_layouts[0].layout, 2);
    }

    #[test]
    fn a_departure_with_a_divider_and_line_breaks_is_shown_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let log = layout_2_log(
            &["| T1 | `a111111` | none |"],
            "### T2\n\n```yaml\ntask: T2\ncommits: [b222222]\ndeparture: |\n  used a | in the header; see note\n  the second line has a | too\n  and a third line\n```\n",
        );
        testutil::commit_file(&master, &format!("{DIR}/build/app.md"), &log, "log app");
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.departures.len(), 1);
        assert_eq!(
            st.departures[0].departure,
            "used a | in the header; see note\nthe second line has a | too\nand a third line"
        );
    }

    #[test]
    fn status_carries_each_tasks_own_plan_text() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(
            st.tasks[0].text,
            "### T1: Do T1 (`app`)\n\n- **Depends on:** none\n- **Change:** something"
        );
        assert_eq!(
            st.tasks[2].text,
            "### T3: Do T3 (`app`)\n\n- **Depends on:** T2\n- **Change:** something"
        );
    }

    #[test]
    fn status_counts_a_committed_row_as_finished_r5_1() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T2 | `abc1234`, `def5678` | none |"]);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        let t2 = &st.tasks[1];
        assert_eq!(t2.id, "T2");
        let row = t2.row.as_ref().expect("T2 is finished");
        assert_eq!(row.commits, vec!["abc1234", "def5678"]);
        assert_eq!(row.repo, "app");
        assert!(st.tasks[0].row.is_none());
        assert_eq!(st.repos[0].finished, 1);
    }

    #[test]
    fn status_reads_one_row_per_task_from_each_repository_log_r5_2() {
        let tmp = tempfile::tempdir().unwrap();
        // The fixture plan without its legacy section, so only the committed logs speak.
        let plan = FIXTURE_PLAN.split("## Build log").next().unwrap();
        let master = master_with(tmp.path(), plan);
        commit_log(&master, "app", &["| T1 | `a1a1a1a` | none |"]);
        commit_log(&master, "api", &["| T2 | `b2b2b2b` | none |"]);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.tasks[0].row.as_ref().unwrap().commits, vec!["a1a1a1a"]);
        assert_eq!(st.tasks[1].row.as_ref().unwrap().commits, vec!["b2b2b2b"]);
        assert_eq!(st.tasks.iter().filter(|t| t.row.is_some()).count(), 2);
        let rows = committed_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(rows.iter().any(|r| r.repo == "app" && r.task == "T1"));
        assert!(rows.iter().any(|r| r.repo == "api" && r.task == "T2"));
    }

    #[test]
    fn status_first_unfinished_is_the_first_task_without_a_row_r6_2() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(
            &master,
            "app",
            &["| T1 | `a111111` | none |", "| T2 | `b222222` | none |"],
        );
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        let app = &st.repos[0];
        assert_eq!(app.repo, "app");
        assert_eq!(app.first_unfinished.as_deref(), Some("T3"));
        assert_eq!(app.state, RepoState::Ready { task: "T3".into() });
        assert_eq!((app.tasks, app.finished), (3, 2));
    }

    #[test]
    fn status_a_committed_task_without_a_row_is_unfinished_r6_5() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(
            &master,
            "app",
            &["| T1 | `a111111` | none |", "| T2 | `b222222` | none |"],
        );
        let app = testutil::repo(tmp.path(), "app");
        std::fs::write(app.join("work.txt"), "t3\n").unwrap();
        git::run(&app, &["add", "--", "work.txt"]).unwrap();
        git::run(
            &app,
            &[
                "commit",
                "-q",
                "-m",
                "feat(sdlc): t3",
                "--trailer",
                "Plan-Task: T3",
            ],
        )
        .unwrap();
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(st.tasks[2].row.is_none());
        assert_eq!(st.repos[0].first_unfinished.as_deref(), Some("T3"));
        assert_eq!(st.repos[0].finished, 2);
    }

    #[test]
    fn status_ignores_an_uncommitted_row_r14_2() {
        let tmp = tempfile::tempdir().unwrap();
        let plan = plan_with(&[
            ("T1", "app", Some("none")),
            ("T2", "app", Some("T1")),
            ("T3", "app", Some("T2")),
            ("T4", "app2", Some("T3")),
        ]);
        let master = master_with(tmp.path(), &plan);
        commit_log(
            &master,
            "app",
            &["| T1 | `a111111` | none |", "| T2 | `b222222` | none |"],
        );
        let path = master.join(format!("{DIR}/build/app.md"));
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("| T3 | `c333333` | none |\n");
        std::fs::write(&path, text).unwrap();
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(st.tasks[2].row.is_none());
        let app2 = st.repos.iter().find(|r| r.repo == "app2").unwrap();
        assert_eq!(
            app2.state,
            RepoState::Waiting {
                task: "T4".into(),
                on_task: "T3".into(),
                on_repo: "app".into()
            }
        );
    }

    #[test]
    fn status_reads_departures_from_the_rows_and_never_writes_r9_3() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(
            &master,
            "app",
            &[
                "| T1 | `a111111` | none |",
                "| T2 | `b222222` | Used a queue because the list blocked. |",
            ],
        );
        let plan_path = master.join(format!("{DIR}/plan.md"));
        let log_path = master.join(format!("{DIR}/build/app.md"));
        let (plan_before, log_before) = (
            std::fs::read(&plan_path).unwrap(),
            std::fs::read(&log_path).unwrap(),
        );
        let porcelain = git::run(&master, &["status", "--porcelain"]).unwrap();
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.departures.len(), 1);
        let d = &st.departures[0];
        assert_eq!((d.task.as_str(), d.repo.as_str()), ("T2", "app"));
        assert_eq!(d.departure, "Used a queue because the list blocked.");
        assert!(d.plan_text.starts_with("### T2: Do T2 (`app`)"));
        assert!(d.plan_text.contains("**Depends on:** T1"));
        assert!(!d.plan_text.contains("T3"));
        assert_eq!(std::fs::read(&plan_path).unwrap(), plan_before);
        assert_eq!(std::fs::read(&log_path).unwrap(), log_before);
        assert_eq!(
            git::run(&master, &["status", "--porcelain"]).unwrap(),
            porcelain
        );
    }

    #[test]
    fn unsaved_rows_finds_untracked_and_added_only_logs_r6_6() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "api", &["| T1 | `a111111` | none |"]);
        let build = master.join(format!("{DIR}/build"));
        std::fs::write(
            build.join("app.md"),
            log_text("app", &["| T1 | `a111111` | none |"]),
        )
        .unwrap();
        let api = build.join("api.md");
        let mut text = std::fs::read_to_string(&api).unwrap();
        text.push_str("| T3 | `c333333` | none |\n");
        // CRLF-insensitive: an editor on Windows may have rewritten the line endings.
        std::fs::write(&api, text.replace('\n', "\r\n")).unwrap();
        let found = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(
            found,
            vec![
                UnsavedRows {
                    repo: "api".into(),
                    tasks: vec!["T3".into()]
                },
                UnsavedRows {
                    repo: "app".into(),
                    tasks: vec!["T1".into()]
                },
            ]
        );
        std::fs::write(
            &api,
            log_text(
                "api",
                &["| T1 | `edited!` | none |", "| T3 | `c333333` | none |"],
            ),
        )
        .unwrap();
        let err = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap_err();
        assert!(err.to_string().contains("api.md"), "got: {err}");
    }

    #[test]
    fn an_added_layout_2_entry_is_an_unsaved_row() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let committed = layout_2_log(
            &["| T1 | `a111111` | none |"],
            "### T2\n\n```yaml\ntask: T2\ncommits: [b222222]\n```\n",
        );
        testutil::commit_file(
            &master,
            &format!("{DIR}/build/app.md"),
            &committed,
            "log app",
        );
        let working =
            format!("{committed}\n### T3\n\n```yaml\ntask: T3\ncommits: [c333333]\n```\n");
        std::fs::write(master.join(format!("{DIR}/build/app.md")), working).unwrap();
        let found = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(
            found,
            vec![UnsavedRows {
                repo: "app".into(),
                tasks: vec!["T3".into()]
            }]
        );
    }

    #[test]
    fn an_added_layout_1_row_is_still_an_unsaved_row() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(
            &master,
            "app",
            &["| T1 | `a111111` | none |", "| T2 | `b222222` | none |"],
        );
        let path = master.join(format!("{DIR}/build/app.md"));
        let mut working = std::fs::read_to_string(&path).unwrap();
        working.push_str(
            "| T3 | `c333333` | none |
",
        );
        std::fs::write(&path, working).unwrap();
        let found = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(
            found,
            vec![UnsavedRows {
                repo: "app".into(),
                tasks: vec!["T3".into()]
            }]
        );
    }

    #[test]
    fn an_edited_entry_is_an_error_naming_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let committed = layout_2_log(
            &[],
            "### T2\n\n```yaml\ntask: T2\ncommits: [b222222]\n```\n",
        );
        testutil::commit_file(
            &master,
            &format!("{DIR}/build/app.md"),
            &committed,
            "log app",
        );
        let working = committed.replace("b222222", "edited1");
        std::fs::write(master.join(format!("{DIR}/build/app.md")), working).unwrap();
        let err = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap_err();
        assert!(err.to_string().contains("app.md"), "got: {err}");
    }

    #[test]
    fn a_new_layout_2_log_is_unsaved() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        let log = layout_2_log(
            &[],
            "### T1\n\n```yaml\ntask: T1\ncommits: [a111111]\n```\n\n### T2\n\n```yaml\ntask: T2\ncommits: [b222222]\n```\n",
        );
        let build = master.join(format!("{DIR}/build"));
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("app.md"), log).unwrap();
        let found = unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(
            found,
            vec![UnsavedRows {
                repo: "app".into(),
                tasks: vec!["T1".into(), "T2".into()]
            }]
        );
    }

    #[test]
    fn unsaved_rows_is_empty_when_nothing_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T1 | `a111111` | none |"]);
        assert!(unsaved_rows(testutil::plugin_dir(), &master, SYS, CHG)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn waiting_names_the_first_dependency_without_a_row() {
        let tmp = tempfile::tempdir().unwrap();
        // The fixture plan without its legacy section, so only the committed log speaks.
        let plan = FIXTURE_PLAN.split("## Build log").next().unwrap();
        let master = master_with(tmp.path(), plan);
        commit_log(&master, "app", &["| T1 | `a111111` | none |"]);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        let app = st.repos.iter().find(|r| r.repo == "app").unwrap();
        assert_eq!(
            app.state,
            RepoState::Waiting {
                task: "T3".into(),
                on_task: "T2".into(),
                on_repo: "api".into()
            }
        );
        let docs = st.repos.iter().find(|r| r.repo == "docs").unwrap();
        assert_eq!(
            docs.state,
            RepoState::Waiting {
                task: "T4".into(),
                on_task: "T3".into(),
                on_repo: "app".into()
            }
        );
        let order: Vec<_> = st.repos.iter().map(|r| r.repo.as_str()).collect();
        assert_eq!(order, ["app", "api", "docs"]);
    }

    #[test]
    fn a_repository_whose_tasks_all_have_rows_is_done() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(
            &master,
            "app",
            &[
                "| T1 | `a111111` | none |",
                "| T2 | `b222222` | none |",
                "| T3 | `c333333` | none |",
            ],
        );
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.repos[0].state, RepoState::Done);
        assert_eq!(st.repos[0].first_unfinished, None);
        assert!(st.has_tasks);
    }

    #[test]
    fn a_committed_log_fixture_gives_its_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        testutil::commit_file(&master, &format!("{DIR}/build/app.md"), BUILD_LOG, "log");
        let rows = committed_rows(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].commits, vec!["a1b2c3d", "e4f5a6b"]);
        assert_eq!(rows[0].departure, None);
        assert_eq!(rows[1].commits, vec!["1111111", "2222222"]);
        assert!(rows[1].departure.is_some());
        assert_eq!(rows[2].departure, None);
        assert!(rows.iter().all(|r| r.repo == "app"));
    }

    #[test]
    fn status_reads_a_plan_with_crlf_line_endings() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks().replace('\n', "\r\n"));
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.tasks.len(), 3);
        assert_eq!(st.tasks[1].depends_on, ["T1"]);
        assert_eq!(st.tasks[1].name, "Do T2");
    }

    #[test]
    fn a_task_without_depends_on_depends_on_every_task_above() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), FIXTURE_PLAN);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert_eq!(st.tasks.len(), 5);
        assert_eq!(st.tasks[4].depends_on, ["T1", "T2", "T3", "T4"]);
        assert_eq!(st.tasks[4].repo, "api");
        assert!(st.tasks[0].depends_on.is_empty());
        assert_eq!(st.tasks[2].depends_on, ["T1", "T2"]);
    }

    #[test]
    fn status_returns_problems_and_keeps_reading() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T1 | | none |"]);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(
            st.problems.iter().any(|p| p.message.contains("no commits")),
            "{:?}",
            st.problems
        );
        assert_eq!(st.tasks.len(), 3);
    }

    #[test]
    fn a_row_for_an_unknown_task_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T9 | `a111111` | none |"]);
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(st.tasks.iter().all(|t| t.row.is_none()));
        assert_eq!(st.repos[0].finished, 0);
    }

    #[test]
    fn status_reads_logs_committed_by_two_writers_together() {
        let tmp = tempfile::tempdir().unwrap();
        let plan = plan_with(&[("T1", "app", Some("none")), ("T2", "api", Some("none"))]);
        let master = master_with(tmp.path(), &plan);
        let build = master.join(format!("{DIR}/build"));
        std::fs::create_dir_all(&build).unwrap();
        for (repo, row) in [
            ("app", "| T1 | `a111111` | none |"),
            ("api", "| T2 | `b222222` | none |"),
        ] {
            std::fs::write(build.join(format!("{repo}.md")), log_text(repo, &[row])).unwrap();
        }
        std::thread::scope(|s| {
            for repo in ["app", "api"] {
                let master = &master;
                s.spawn(move || {
                    let rel = format!("{DIR}/build/{repo}.md");
                    let msg = format!("docs(sdlc): log {repo}");
                    for _ in 0..200 {
                        let done = git::run(master, &["add", "--", &rel]).and_then(|_| {
                            git::run(master, &["commit", "-q", "-m", &msg, "--", &rel])
                        });
                        match done {
                            Ok(_) => return,
                            Err(e) if e.stderr.contains("index.lock") => {
                                std::thread::sleep(std::time::Duration::from_millis(50))
                            }
                            Err(e) => panic!("{e}"),
                        }
                    }
                    panic!("index.lock never cleared");
                });
            }
        });
        let st = status(testutil::plugin_dir(), &master, SYS, CHG).unwrap();
        assert!(st.tasks.iter().all(|t| t.row.is_some()), "{st:?}");
    }

    // ---- the build gate (R8, R10.1) ----

    const VALID_PLAN: &str = include_str!("../tests/ai-sdlc-format/examples/plan/2/valid.md");
    const PLAN_WITHOUT_TESTS: &str =
        include_str!("../tests/ai-sdlc-format/examples/plan/2/task-without-tests-section.md");
    const VALID_LOG: &str = include_str!("../tests/ai-sdlc-format/examples/build-log/2/valid.md");
    const LOG_WITH_TWICE: &str =
        include_str!("../tests/ai-sdlc-format/examples/build-log/2/entry-recorded-twice.md");

    /// A stand-in plugin folder whose format program answers every read with an empty document: a
    /// plan in `plan_layout` and a build log in `log_layout`.
    fn plugin_reading(plan_layout: u32, log_layout: u32) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let format = dir.path().join("format");
        std::fs::create_dir_all(&format).unwrap();
        std::fs::write(
            format.join("check.mjs"),
            format!(
                "const file = process.argv[4] ?? '';\n\
                 const plan = file.endsWith('plan.md');\n\
                 const document = plan ? {{ tasks: [], shared_decisions: [] }} : {{ repo: 'app', entries: [] }};\n\
                 console.log(JSON.stringify({{ kind: plan ? 'plan' : 'build-log', layout: plan ? {plan_layout} : {log_layout}, document, problems: [] }}));\n"
            ),
        )
        .unwrap();
        dir
    }

    fn ready(dir: &Path) -> Readiness {
        Readiness::Ready {
            dir: dir.to_path_buf(),
            version: "0.8.0".into(),
            layouts: format::ACCEPTED_LAYOUTS.to_vec(),
        }
    }

    fn refuse(message: &str, problems: Vec<Problem>) -> Gate {
        Gate::Refuse {
            message: message.into(),
            problems,
        }
    }

    fn problem(file: &str, line: u32, message: &str) -> Problem {
        Problem {
            file: file.into(),
            line,
            message: message.into(),
        }
    }

    /// (name, plugin, plan, build logs as (repository, text), expected outcome)
    type GateRow<'a> = (&'a str, Readiness, &'a str, Vec<(&'a str, &'a str)>, Gate);

    #[test]
    fn build_gate_refuses_each_action_with_the_problems_listed() {
        let real = testutil::plugin_dir();
        let newer_plan = plugin_reading(3, 1);
        let newer_both = plugin_reading(3, 3);
        let newer_log = plugin_reading(1, 3);
        let plan_problem = problem("plan.md", 18, "task T1 has no Tests section");
        let log_problem = problem(
            "build/app.md",
            14,
            "entry T1 is recorded twice, first on line 7",
        );
        // (name, plugin, plan, logs, expected): the outline's rows, then the precedence between them.
        let rows: Vec<GateRow> = vec![
            (
                "plugin missing",
                Readiness::Missing,
                VALID_PLAN,
                vec![],
                refuse("Install the ai-sdlc plugin", vec![]),
            ),
            (
                "plugin too old",
                Readiness::TooOld {
                    have: "0.7.9".into(),
                    need: "0.8.0".into(),
                },
                VALID_PLAN,
                vec![],
                refuse("Update the ai-sdlc plugin to 0.8.0 or later", vec![]),
            ),
            (
                "plugin missing wins over a failing plan and log",
                Readiness::Missing,
                PLAN_WITHOUT_TESTS,
                vec![("app", LOG_WITH_TWICE)],
                refuse("Install the ai-sdlc plugin", vec![]),
            ),
            (
                "plan in a newer layout",
                ready(newer_plan.path()),
                VALID_PLAN,
                vec![],
                refuse("This plan needs a newer Workbench", vec![]),
            ),
            (
                "plan in a newer layout wins over a log in a newer layout",
                ready(newer_both.path()),
                VALID_PLAN,
                vec![("app", VALID_LOG)],
                refuse("This plan needs a newer Workbench", vec![]),
            ),
            (
                "plan with problems",
                ready(real),
                PLAN_WITHOUT_TESTS,
                vec![],
                refuse(
                    "The plan does not pass the check",
                    vec![plan_problem.clone()],
                ),
            ),
            (
                "plan with problems wins over a log with problems",
                ready(real),
                PLAN_WITHOUT_TESTS,
                vec![("app", LOG_WITH_TWICE)],
                refuse("The plan does not pass the check", vec![plan_problem]),
            ),
            (
                "build log in a newer layout",
                ready(newer_log.path()),
                VALID_PLAN,
                vec![("app", VALID_LOG)],
                refuse("A build log needs a newer Workbench", vec![]),
            ),
            (
                "build log with problems",
                ready(real),
                VALID_PLAN,
                vec![("app", LOG_WITH_TWICE)],
                refuse("A build log does not pass the check", vec![log_problem]),
            ),
            (
                "plan and build log pass",
                ready(real),
                VALID_PLAN,
                vec![("app", VALID_LOG)],
                Gate::Admit,
            ),
            (
                "plan passes and there is no build log yet",
                ready(real),
                VALID_PLAN,
                vec![],
                Gate::Admit,
            ),
        ];
        for (name, plugin, plan, logs, expected) in rows {
            let tmp = tempfile::tempdir().unwrap();
            let master = master_with(tmp.path(), plan);
            for (repo, text) in logs {
                testutil::commit_file(
                    &master,
                    &format!("{DIR}/build/{repo}.md"),
                    text,
                    &format!("log {repo}"),
                );
            }
            for action in [
                BuildAction::Start,
                BuildAction::Continue,
                BuildAction::Round,
            ] {
                assert_eq!(
                    gate(&plugin, &master, SYS, CHG, action).unwrap(),
                    expected,
                    "{name}, {action:?}"
                );
            }
        }
    }

    #[test]
    fn build_gate_admits_once_the_plan_passes_again() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), PLAN_WITHOUT_TESTS);
        let plugin = ready(testutil::plugin_dir());
        let plan = format!("{DIR}/plan.md");
        let log = format!("{DIR}/build/app.md");
        for action in [BuildAction::Start, BuildAction::Continue] {
            assert!(matches!(
                gate(&plugin, &master, SYS, CHG, action).unwrap(),
                Gate::Refuse { .. }
            ));
        }
        testutil::commit_file(&master, &plan, VALID_PLAN, "fix the plan");
        testutil::commit_file(&master, &log, LOG_WITH_TWICE, "log with a repeat");
        assert!(matches!(
            gate(&plugin, &master, SYS, CHG, BuildAction::Continue).unwrap(),
            Gate::Refuse { .. }
        ));
        testutil::commit_file(&master, &log, VALID_LOG, "fix the log");
        for action in [
            BuildAction::Start,
            BuildAction::Continue,
            BuildAction::Round,
        ] {
            assert_eq!(
                gate(&plugin, &master, SYS, CHG, action).unwrap(),
                Gate::Admit
            );
        }
    }

    /// Commits the master's marker listing `repos` under the system `demo`, which the plans in this test name.
    fn commit_marker(master: &Path, repos: &[&str]) {
        let listed: Vec<String> = repos.iter().map(|r| format!("\"{r}\"")).collect();
        testutil::commit_file(
            master,
            ".ai-sdlc.json",
            &format!(
                "{{\"version\":1,\"systems\":{{\"demo\":{{\"repos\":[{}]}}}}}}",
                listed.join(",")
            ),
            "marker",
        );
    }

    #[test]
    fn build_gate_refuses_what_only_the_checks_across_documents_find() {
        let two_repos = VALID_PLAN.replace(
            "id: T2
repo: app",
            "id: T2
repo: api",
        );
        assert_ne!(two_repos, VALID_PLAN);
        let log_on_other_repo = VALID_LOG.replace("app", "api");
        // (name, plan, marker repos, build logs as (repository, text), message, a word in a problem)
        type Case<'a> = (
            &'a str,
            String,
            &'a [&'a str],
            Vec<(&'a str, String)>,
            &'a str,
            &'a str,
        );
        let cases: Vec<Case> = vec![
            (
                "a log entry on another repository's task",
                two_repos.clone(),
                &["app", "api"],
                vec![("api", log_on_other_repo)],
                "A build log does not pass the check",
                "belongs to repository app",
            ),
            (
                "a task naming a repository the system does not list",
                two_repos,
                &["app"],
                vec![],
                "The plan does not pass the check",
                "api",
            ),
            (
                "a dependency on a task the plan does not hold",
                VALID_PLAN.replace("depends_on: [T1]", "depends_on: [T99]"),
                &["app"],
                vec![],
                "The plan does not pass the check",
                "T99",
            ),
        ];
        let plugin = ready(testutil::plugin_dir());
        let mut wrong = Vec::new();
        for (name, plan, repos, logs, message, word) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let master = master_with(tmp.path(), &plan);
            commit_marker(&master, repos);
            for (repo, text) in logs {
                testutil::commit_file(
                    &master,
                    &format!("{DIR}/build/{repo}.md"),
                    &text,
                    &format!("log {repo}"),
                );
            }
            match gate(&plugin, &master, SYS, CHG, BuildAction::Start).unwrap() {
                Gate::Refuse {
                    message: got,
                    problems,
                } if got == message && problems.iter().any(|p| p.message.contains(word)) => {}
                other => wrong.push(format!("{name}: {other:?}")),
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn two_changes_are_read_at_the_same_time() {
        // The stand-in program starts, then waits until another copy of it has started too. If the
        // reads of two changes took turns, the first would give up waiting and never meet the other.
        let rendezvous = tempfile::tempdir().unwrap();
        let plugin = tempfile::tempdir().unwrap();
        let format_dir = plugin.path().join("format");
        std::fs::create_dir_all(&format_dir).unwrap();
        std::fs::write(
            format_dir.join("check.mjs"),
            format!(
                "import {{ readdirSync, writeFileSync }} from 'node:fs';
                 if (process.argv[2] === 'check') process.exit(0);
                 const dir = {dir:?};
                 writeFileSync(dir + '/start-' + process.pid, '');
                 const give_up = Date.now() + 10000;
                 const started = () => readdirSync(dir).filter((n) => n.startsWith('start-')).length;
                 while (started() < 2 && Date.now() < give_up) {{}}
                 if (started() >= 2) writeFileSync(dir + '/met-' + process.pid, '');
                 console.log(JSON.stringify({{ kind: 'plan', layout: 1, document: {{ tasks: [], shared_decisions: [] }}, problems: [] }}));
",
                dir = rendezvous.path().display().to_string()
            ),
        )
        .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let master = testutil::repo(tmp.path(), "master");
        let changes = ["2026-10-12-fnol", "2026-10-13-other"];
        for (change, repo) in changes.iter().zip(["app", "api"]) {
            testutil::commit_file(
                &master,
                &format!("intent/{SYS}/{change}/plan.md"),
                &plan_with(&[("T1", repo, Some("none"))]),
                "plan",
            );
        }
        std::thread::scope(|s| {
            for change in changes {
                let (plugin, master) = (plugin.path(), &master);
                s.spawn(move || status(plugin, master, SYS, change).unwrap());
            }
        });
        let met = std::fs::read_dir(rendezvous.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("met-"))
            .count();
        assert_eq!(met, 2, "each read should have met the other");
    }
}

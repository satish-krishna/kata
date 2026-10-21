//! The build's state, read from the plan and the build logs as committed in the master
//! repository. This follows the ai-sdlc build skill's reading rule (section 1, step 5): nothing
//! else in Kata parses `plan.md` headings or `build/<repo>.md`.
use crate::git::{self, GitError};
use serde::Serialize;
use std::path::Path;

/// One `### T<n>: <name> (`<repo>`)` task of the plan.
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
    /// The task's own section of the plan, from its heading to the next task heading.
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

/// `T<digits>` as a whole token, or `None`.
fn is_task_id(s: &str) -> bool {
    s.strip_prefix('T')
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// A folder-like name: the plugin's own template heading carries `<repo>`, which is not one.
fn is_repo_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `### T<digits>: <name> (`<repo>`)` -> (id, name, repo).
fn task_heading(line: &str) -> Option<(String, String, String)> {
    let rest = line.trim_end().strip_prefix("### T")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let id = format!("T{}", &rest[..digits]);
    let rest = rest[digits..].strip_prefix(": ")?;
    let rest = rest.strip_suffix("`)")?;
    let at = rest.rfind(" (`")?;
    let (name, repo) = (rest[..at].trim(), &rest[at + 3..]);
    if name.is_empty() || !is_repo_name(repo) {
        return None;
    }
    Some((id, name.to_string(), repo.to_string()))
}

/// The task IDs a `- **Depends on:**` value names; `none` and prose without IDs give none.
fn dependency_ids(value: &str) -> Vec<String> {
    value
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| is_task_id(w))
        .map(str::to_string)
        .collect()
}

/// One heading found in the plan: where its section starts and ends, in lines.
struct Section {
    task: PlanTask,
    text: String,
}

fn sections(plan: &str) -> Vec<Section> {
    let lines: Vec<&str> = plan.lines().collect();
    let heads: Vec<(usize, (String, String, String))> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| task_heading(l).map(|h| (i, h)))
        .collect();
    let mut out: Vec<Section> = Vec::new();
    for (n, (start, (id, name, repo))) in heads.iter().enumerate() {
        let limit = heads.get(n + 1).map_or(lines.len(), |(i, _)| *i);
        let end = (start + 1..limit)
            .find(|&i| lines[i].starts_with("## ") || lines[i].starts_with("### "))
            .unwrap_or(limit);
        let text = lines[*start..end].join("\n").trim_end().to_string();
        let depends = lines[start + 1..end].iter().find_map(|l| {
            l.trim_start()
                .strip_prefix("- **Depends on:**")
                .map(dependency_ids)
        });
        let depends_on = depends.unwrap_or_else(|| out.iter().map(|s| s.task.id.clone()).collect());
        out.push(Section {
            task: PlanTask {
                id: id.clone(),
                name: name.clone(),
                repo: repo.clone(),
                depends_on,
            },
            text,
        });
    }
    out
}

/// Every `### T<digits>: <name> (`<repo>`)` heading in document order, with its dependencies.
/// A task with no `Depends on` line depends on every task above it.
pub fn plan_tasks(plan: &str) -> Vec<PlanTask> {
    sections(plan).into_iter().map(|s| s.task).collect()
}

fn cells(line: &str) -> Option<Vec<&str>> {
    let line = line.trim();
    let inner = line.strip_prefix('|')?;
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    Some(inner.split('|').map(str::trim).collect())
}

fn is_separator(cells: &[&str]) -> bool {
    cells
        .iter()
        .all(|c| !c.is_empty() && c.chars().all(|ch| matches!(ch, '-' | ':' | ' ')))
}

fn commits_in(cell: &str) -> Vec<String> {
    if cell.contains('`') {
        cell.split('`')
            .skip(1)
            .step_by(2)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        cell.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    }
}

/// The table rows of a build log (or a legacy plan's `## Build log` table). A header naming a
/// `Repository` column makes the rows carry their own repository; otherwise it is `repo`.
fn rows_in(text: &str, repo: &str) -> Vec<BuildRow> {
    // Column positions; the defaults are the build log's `Task | Commits | Departure`.
    let (mut task_at, mut repo_at, mut commits_at, mut departure_at) = (0, None, 1, 2);
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(row) = cells(line) else { continue };
        if is_separator(&row) {
            continue;
        }
        if row[0].eq_ignore_ascii_case("task") {
            let find = |name: &str| row.iter().position(|c| c.eq_ignore_ascii_case(name));
            task_at = 0;
            repo_at = find("repository");
            commits_at = find("commits").unwrap_or(commits_at);
            departure_at = find("departure").unwrap_or(departure_at);
            continue;
        }
        if !is_task_id(row[task_at]) {
            continue;
        }
        let cell = |i: usize| row.get(i).copied().unwrap_or("");
        // The last column takes the rest of the line, so a `|` in a departure survives.
        let departure = if departure_at + 1 == row.len() || departure_at >= row.len() {
            cell(departure_at).to_string()
        } else {
            row[departure_at..].join("|")
        };
        let departure = Some(departure.trim().to_string())
            .filter(|d| !d.is_empty() && !d.eq_ignore_ascii_case("none"));
        out.push(BuildRow {
            task: row[task_at].to_string(),
            repo: repo_at
                .map(|i| cell(i).to_string())
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| repo.to_string()),
            commits: commits_in(cell(commits_at)),
            departure,
        });
    }
    out
}

/// The legacy plan's `## Build log` section, up to the next `## ` heading.
fn legacy_log(plan: &str) -> String {
    let mut inside = false;
    let mut out = Vec::new();
    for line in plan.lines() {
        if line.trim_end().eq_ignore_ascii_case("## Build log") {
            inside = true;
        } else if line.starts_with("## ") {
            inside = false;
        } else if inside {
            out.push(line);
        }
    }
    out.join("\n")
}

fn change_dir(system: &str, change: &str) -> String {
    format!("intent/{system}/{change}")
}

fn committed_plan(master: &Path, system: &str, change: &str) -> Result<String, GitError> {
    let path = format!("HEAD:{}/plan.md", change_dir(system, change));
    git::run(master, &["show", &path])
}

/// The file stem of a build log path: the repository it logs.
fn log_repo(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
}

fn rows_from(
    master: &Path,
    system: &str,
    change: &str,
    plan: &str,
) -> Result<Vec<BuildRow>, GitError> {
    let dir = format!("{}/build/", change_dir(system, change));
    let listing = git::run(
        master,
        &["ls-tree", "-z", "--name-only", "HEAD", "--", &dir],
    )?;
    let mut paths: Vec<&str> = listing.split('\0').filter(|p| !p.is_empty()).collect();
    paths.sort_unstable();
    let mut rows = Vec::new();
    for path in paths {
        let text = git::run(master, &["show", &format!("HEAD:{path}")])?;
        rows.extend(rows_in(&text, log_repo(path)));
    }
    rows.extend(rows_in(&legacy_log(plan), ""));
    Ok(rows)
}

/// Every build log row as committed at `HEAD` (never the working tree), plus the committed
/// plan's legacy `## Build log`.
pub fn committed_rows(
    master: &Path,
    system: &str,
    change: &str,
) -> Result<Vec<BuildRow>, GitError> {
    let plan = committed_plan(master, system, change)?;
    rows_from(master, system, change, &plan)
}

pub fn status(master: &Path, system: &str, change: &str) -> Result<BuildStatus, GitError> {
    let plan = committed_plan(master, system, change)?;
    let rows = rows_from(master, system, change, &plan)?;
    let sections = sections(&plan);
    let row_of = |id: &str| rows.iter().find(|r| r.task == id);

    let tasks: Vec<TaskStatus> = sections
        .iter()
        .map(|s| TaskStatus {
            id: s.task.id.clone(),
            name: s.task.name.clone(),
            repo: s.task.repo.clone(),
            depends_on: s.task.depends_on.clone(),
            text: s.text.clone(),
            row: row_of(&s.task.id).cloned(),
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

    let departures = sections
        .iter()
        .zip(&tasks)
        .filter_map(|(s, t)| {
            let row = t.row.as_ref()?;
            Some(Departure {
                task: t.id.clone(),
                repo: row.repo.clone(),
                plan_text: s.text.clone(),
                departure: row.departure.clone()?,
            })
        })
        .collect();

    Ok(BuildStatus {
        has_tasks: !tasks.is_empty(),
        tasks,
        repos,
        departures,
    })
}

fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// Build log rows written to the working tree and not committed. A log is unsaved when it is
/// untracked, or when its text is the committed text plus added rows (CRLF-insensitive). Any
/// other change to a log is an error naming the file, since the build skill would refuse it.
pub fn unsaved_rows(
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
        .collect();
    names.sort_unstable();
    let mut out = Vec::new();
    for name in names {
        let rel = format!("{rel_dir}/{name}");
        let refuse = |why: &str| GitError {
            args: rel.clone(),
            stderr: why.to_string(),
        };
        let working =
            lf(&std::fs::read_to_string(master.join(&rel)).map_err(|e| refuse(&e.to_string()))?);
        let repo = log_repo(&rel);
        let listed = git::run(master, &["ls-tree", "--name-only", "HEAD", "--", &rel])?;
        if listed.is_empty() {
            out.push(UnsavedRows {
                repo: repo.to_string(),
                tasks: rows_in(&working, repo)
                    .into_iter()
                    .map(|r| r.task)
                    .collect(),
            });
            continue;
        }
        let committed = lf(&git::run(master, &["show", &format!("HEAD:{rel}")])?);
        let committed = committed.trim_end();
        let Some(added) = working.trim_end().strip_prefix(committed) else {
            return Err(refuse(
                "an uncommitted change to a build log other than added rows",
            ));
        };
        if added.is_empty() {
            continue;
        }
        let only_rows = added.starts_with('\n')
            && added
                .lines()
                .all(|l| l.trim().is_empty() || l.trim_start().starts_with('|'));
        if !only_rows {
            return Err(refuse(
                "an uncommitted change to a build log other than added rows",
            ));
        }
        out.push(UnsavedRows {
            repo: repo.to_string(),
            tasks: rows_in(added, repo).into_iter().map(|r| r.task).collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    const SYS: &str = "claims";
    const CHG: &str = "2026-10-12-fnol";
    const DIR: &str = "intent/claims/2026-10-12-fnol";
    const FIXTURE_PLAN: &str = include_str!("testdata/plan.md");
    const TEMPLATE: &str = include_str!("testdata/plan-template.md");
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
        let st = status(&master, SYS, CHG).unwrap();
        assert_eq!(st.tasks.len(), 30);
        assert!(st.tasks.iter().all(|t| t.row.is_some()), "{st:?}");
        assert!(st.repos.iter().all(|r| r.state == RepoState::Done));
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
        let st = status(&master, SYS, CHG).unwrap();
        assert_eq!(st.tasks[0].row.as_ref().unwrap().commits, vec!["a111111"]);
        assert_eq!(st.tasks[1].row.as_ref().unwrap().commits, vec!["b222222"]);
        assert!(st.tasks[2].row.is_none());
        assert_eq!((st.repos[0].tasks, st.repos[0].finished), (3, 2));
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
        assert_eq!(st.tasks[0].row.as_ref().unwrap().commits, vec!["a1a1a1a"]);
        assert_eq!(st.tasks[1].row.as_ref().unwrap().commits, vec!["b2b2b2b"]);
        assert_eq!(st.tasks.iter().filter(|t| t.row.is_some()).count(), 2);
        let rows = committed_rows(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
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
        let found = unsaved_rows(&master, SYS, CHG).unwrap();
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
        let err = unsaved_rows(&master, SYS, CHG).unwrap_err();
        assert!(err.to_string().contains("api.md"), "got: {err}");
    }

    #[test]
    fn unsaved_rows_is_empty_when_nothing_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T1 | `a111111` | none |"]);
        assert!(unsaved_rows(&master, SYS, CHG).unwrap().is_empty());
    }

    #[test]
    fn waiting_names_the_first_dependency_without_a_row() {
        let tmp = tempfile::tempdir().unwrap();
        // The fixture plan without its legacy section, so only the committed log speaks.
        let plan = FIXTURE_PLAN.split("## Build log").next().unwrap();
        let master = master_with(tmp.path(), plan);
        commit_log(&master, "app", &["| T1 | `a111111` | none |"]);
        let st = status(&master, SYS, CHG).unwrap();
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
        let st = status(&master, SYS, CHG).unwrap();
        assert_eq!(st.repos[0].state, RepoState::Done);
        assert_eq!(st.repos[0].first_unfinished, None);
        assert!(st.has_tasks);
    }

    #[test]
    fn a_task_without_depends_on_depends_on_every_task_above() {
        let tasks = plan_tasks(FIXTURE_PLAN);
        let t5 = tasks.iter().find(|t| t.id == "T5").unwrap();
        assert_eq!(t5.depends_on, ["T1", "T2", "T3", "T4"]);
        assert_eq!(t5.repo, "api");
        assert_eq!(t5.name, "Audit log");
    }

    #[test]
    fn depends_on_none_is_empty() {
        let tasks = plan_tasks(FIXTURE_PLAN);
        assert!(tasks[0].depends_on.is_empty());
        assert_eq!(tasks[2].depends_on, ["T1", "T2"]);
        assert_eq!(tasks.len(), 5);
    }

    #[test]
    fn the_plugin_template_parses_as_an_empty_plan() {
        assert!(plan_tasks(TEMPLATE).is_empty());
    }

    #[test]
    fn legacy_build_log_rows_count() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), FIXTURE_PLAN);
        let rows = committed_rows(&master, SYS, CHG).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].repo, "app");
        assert_eq!(rows[1].repo, "api");
        assert_eq!(rows[1].commits, vec!["bbb2222", "ccc3333"]);
        assert!(rows[1].departure.as_deref().unwrap().starts_with("Skipped"));
        let st = status(&master, SYS, CHG).unwrap();
        assert!(st.tasks[0].row.is_some() && st.tasks[1].row.is_some());
    }

    #[test]
    fn build_log_fixture_rows_parse() {
        let rows = rows_in(BUILD_LOG, "app");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].commits, vec!["a1b2c3d", "e4f5a6b"]);
        assert_eq!(rows[0].departure, None);
        assert_eq!(rows[1].commits, vec!["1111111", "2222222"]);
        assert!(rows[1].departure.is_some());
        assert_eq!(rows[2].departure, None);
        assert!(rows.iter().all(|r| r.repo == "app"));
    }

    #[test]
    fn a_row_for_an_unknown_task_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let master = master_with(tmp.path(), &app_tasks());
        commit_log(&master, "app", &["| T9 | `a111111` | none |"]);
        let st = status(&master, SYS, CHG).unwrap();
        assert!(st.tasks.iter().all(|t| t.row.is_none()));
        assert_eq!(st.repos[0].finished, 0);
    }

    #[test]
    fn parses_crlf_plans() {
        let tasks = plan_tasks(&app_tasks().replace('\n', "\r\n"));
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[1].depends_on, ["T1"]);
        assert_eq!(tasks[1].repo, "app");
        assert_eq!(tasks[1].name, "Do T2");
    }

    #[test]
    fn plan_tasks_ignores_other_heading_styles() {
        let plan = "## Tasks\n\n### Task 1: Old style\n\n#### T2: Too deep (`app`)\n\n### T3 Missing colon (`app`)\n\n### T4: No repo\n\n### T5: Real (`app`)\n";
        let tasks = plan_tasks(plan);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "T5");
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
        let st = status(&master, SYS, CHG).unwrap();
        assert!(st.tasks.iter().all(|t| t.row.is_some()), "{st:?}");
    }
}

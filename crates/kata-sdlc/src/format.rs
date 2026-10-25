//! Runs the ai-sdlc plugin's format program (`check.mjs`) and reads its answer.
//!
//! The program is the one place that knows how a spec, a plan, a build log or a review is laid
//! out; Kata never parses those documents itself. `read` asks it for the parsed document
//! (`check.mjs read --json`) and `check_change` asks it to check a change's documents against each
//! other (`check.mjs check`). The program is spawned with an argv array (never a shell), a null
//! stdin and a 30-second timeout that kills its whole process tree.
//!
//! The types below mirror `schema/read-result.schema.json` field for field, so they keep the
//! program's snake_case names.
use crate::process::{self, ProcessError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// How long the program may run before its process tree is killed.
const TIMEOUT: Duration = Duration::from_secs(30);

/// One thing wrong with a document: where it is and what it is.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct Problem {
    pub file: String,
    pub line: u32,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedScenario {
    pub id: String,
    pub title: String,
    pub outline: bool,
    pub steps: Vec<String>,
    pub examples: Option<Vec<Vec<String>>>,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedRequirement {
    pub id: String,
    pub title: String,
    pub from: Vec<String>,
    pub scenarios: Vec<ParsedScenario>,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedSpec {
    pub requirements: Vec<ParsedRequirement>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedSection {
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedTask {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub depends_on: Vec<String>,
    pub uses: Vec<String>,
    pub files: Vec<String>,
    pub covers: Vec<String>,
    pub supports: Vec<String>,
    pub sections: Vec<ParsedSection>,
    pub text: String,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedSharedDecision {
    pub question: String,
    pub owner: String,
    pub function: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedPlan {
    pub tasks: Vec<ParsedTask>,
    pub shared_decisions: Vec<ParsedSharedDecision>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedBuildEntry {
    pub task: String,
    pub commits: Vec<String>,
    pub departure: Option<String>,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedBuildLog {
    pub repo: String,
    pub entries: Vec<ParsedBuildEntry>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Severity {
    High,
    Medium,
    Low,
}

/// What a review finding concerns.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Concern {
    Spec,
    Bug,
    Convention,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedFinding {
    pub id: String,
    pub severity: Severity,
    pub file: String,
    pub line: u32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub concern: Option<Concern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rule: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedReviewSection {
    pub number: u32,
    pub reviewed_at: String,
    pub commits: BTreeMap<String, String>,
    pub findings: Vec<ParsedFinding>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ParsedReview {
    pub reviews: Vec<ParsedReviewSection>,
}

/// The document layout versions Kata can read; a document in any other layout is shown as plain text and blocks building.
pub const ACCEPTED_LAYOUTS: &[u32] = &[1, 2];

/// What `check.mjs read --json <file>` prints: the parsed document, its layout version, and every
/// problem found in it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum ReadResult {
    Spec {
        layout: u32,
        document: ParsedSpec,
        problems: Vec<Problem>,
    },
    Plan {
        layout: u32,
        document: ParsedPlan,
        problems: Vec<Problem>,
    },
    BuildLog {
        layout: u32,
        document: ParsedBuildLog,
        problems: Vec<Problem>,
    },
    Review {
        layout: u32,
        document: ParsedReview,
        problems: Vec<Problem>,
    },
}

impl ReadResult {
    /// Every problem the program found in the document.
    pub fn problems(&self) -> &[Problem] {
        match self {
            ReadResult::Spec { problems, .. }
            | ReadResult::Plan { problems, .. }
            | ReadResult::BuildLog { problems, .. }
            | ReadResult::Review { problems, .. } => problems,
        }
    }

    /// The layout version the document declares.
    pub fn layout(&self) -> u32 {
        match self {
            ReadResult::Spec { layout, .. }
            | ReadResult::Plan { layout, .. }
            | ReadResult::BuildLog { layout, .. }
            | ReadResult::Review { layout, .. } => *layout,
        }
    }
}

/// Why the program could not give an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FormatError {
    /// `node` is not on this machine's PATH.
    #[error("Node.js was not found on this machine; ai-sdlc needs Node.js 20 or later")]
    NodeMissing,
    /// The program ran and said it could not work on the file (exit 2), or was killed.
    #[error("the format program could not run: {0}")]
    CouldNotRun(String),
    /// The program exited normally but its output is not the answer it promises.
    #[error("the format program printed something unreadable: {0}")]
    BadOutput(String),
}

/// How many times the program has been started in this process.
static RUNS: AtomicUsize = AtomicUsize::new(0);

/// How many times the program has been started in this process; a cache hit starts none.
pub fn runs_started() -> usize {
    RUNS.load(Ordering::SeqCst)
}

/// What a read depends on: the program, the document's name below its change folder (`plan.md`,
/// `build/app.md`; the program takes the kind, a build log's repository and the file name in each
/// problem from it), the document's bytes, and, for a plan, the bytes of the marker above it.
type CacheKey = (PathBuf, String, u64, u64);

fn cache() -> &'static Mutex<HashMap<CacheKey, ReadResult>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, ReadResult>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Reads one document with `program` (the path of `check.mjs`). A document with the same name below
/// its change folder and the same bytes is read once, wherever it sits: the next call returns the
/// earlier answer without starting the program.
pub fn read(program: &Path, file: &Path) -> Result<ReadResult, FormatError> {
    let canonical = file
        .canonicalize()
        .map_err(|e| FormatError::CouldNotRun(format!("{}: {e}", file.display())))?;
    let bytes = std::fs::read(&canonical)
        .map_err(|e| FormatError::CouldNotRun(format!("{}: {e}", file.display())))?;
    let (folder, relative) = change_folder(file);
    // The program is part of the key: a different plugin version may read the same bytes differently.
    let key = (
        program.canonicalize().unwrap_or_else(|_| program.into()),
        relative.clone(),
        hash_of(&bytes),
        if relative == "plan.md" {
            marker_hash(&canonical)
        } else {
            0
        },
    );
    if let Some(hit) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(hit.clone());
    }

    let output = run(program, &folder, &["read", "--json", &relative])?;
    let result: ReadResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| FormatError::BadOutput(format!("{e}{}", stderr_note(&output.stderr))))?;
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, result.clone());
    Ok(result)
}

/// Checks a change's documents against each other and against their own layout. `folder` is the
/// change's folder; `documents` are paths below it (`spec.md`, `plan.md`, `build/<repo>.md`,
/// `build/review.md`). Returns every problem found, sorted as the program sorts them; an empty list
/// means the documents pass.
pub fn check_change(
    program: &Path,
    folder: &Path,
    documents: &[&str],
) -> Result<Vec<Problem>, FormatError> {
    // Like `read`, an unchanged change starts nothing: the key is the program, each document's name and
    // bytes, and the marker above them. A document that cannot be read is left to the program to report.
    let key = documents
        .iter()
        .map(|d| std::fs::read(folder.join(d)).map(|bytes| (d.to_string(), hash_of(&bytes))))
        .collect::<Result<Vec<_>, _>>()
        .ok()
        .map(|hashes| {
            (
                program.canonicalize().unwrap_or_else(|_| program.into()),
                hashes,
                marker_hash(&folder.join("plan.md")),
            )
        });
    if let Some(hit) = key.as_ref().and_then(|k| {
        check_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(k)
            .cloned()
    }) {
        return Ok(hit);
    }

    let mut args = vec!["check"];
    args.extend(documents);
    let output = run(program, folder, &args)?;
    let problems: Vec<Problem> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            parse_problem(line).ok_or_else(|| {
                FormatError::BadOutput(format!(
                    "not a problem line: {line}{}",
                    stderr_note(&output.stderr)
                ))
            })
        })
        .collect::<Result<_, _>>()?;
    if let Some(key) = key {
        check_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, problems.clone());
    }
    Ok(problems)
}

/// What the program found out about one document of a fix.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixDocumentFacts {
    /// The document's file is in `HEAD`.
    pub in_head: bool,
    /// The `status` of the `HEAD` copy; `None` when `HEAD` does not hold it or names none.
    pub head_status: Option<String>,
    /// The `status` of the working copy; `None` when there is none or it names none.
    pub working_status: Option<String>,
}

/// How many of a fix's documents are accepted in `HEAD`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FixAccepted {
    /// None of the three documents is accepted in `HEAD`.
    None,
    /// The intent, or the intent and the spec, are accepted in `HEAD`.
    Leading,
    /// All three documents are accepted in `HEAD`.
    All,
    /// Any other set of accepted documents; the program's row 2 catches it.
    Other,
}

/// The facts behind a row of the fix-state table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixFacts {
    /// The intent's facts.
    pub intent: FixDocumentFacts,
    /// The spec's facts.
    pub spec: FixDocumentFacts,
    /// The plan's facts.
    pub plan: FixDocumentFacts,
    /// The documents with unrecorded changes, in document order.
    pub unrecorded: Vec<String>,
    /// Some document differs from `HEAD` and every difference is an acceptance's own status lines.
    pub own_lines_only: bool,
    /// Which documents are accepted in `HEAD`.
    pub accepted: FixAccepted,
    /// The latest commit touching the documents is one of the three acceptances.
    pub acceptance_last: bool,
    /// Some task of the plan in `HEAD` has an entry in a build log in `HEAD`.
    pub built: bool,
}

/// What `check.mjs fix-state --json <change folder>` prints: the row of the fix-state table (1 to 8)
/// and the facts it was decided on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FixState {
    /// The row of the fix-state table, 1 to 8.
    pub row: u8,
    /// What the row was decided on.
    pub facts: FixFacts,
}

/// Where the fix in `folder` stands, as the program says. Not cached: the answer depends on git's state
/// (`HEAD`, the index, the working tree), not on the bytes of any one file.
pub fn fix_state(program: &Path, folder: &Path) -> Result<FixState, FormatError> {
    let output = run(program, folder, &["fix-state", "--json", "."])?;
    serde_json::from_slice(&output.stdout)
        .map_err(|e| FormatError::BadOutput(format!("{e}{}", stderr_note(&output.stderr))))
}

/// One entry of the program's answer for several folders: the folder as it was given, and either its
/// result or the error that stopped the program for it.
#[derive(Deserialize)]
struct FixEntry {
    folder: String,
    result: Option<FixState>,
    error: Option<String>,
}

/// Where each fix in `folders` stands, in the order given, from one process per chunk of folders. A folder the program could
/// not answer for gets its own error; a run that failed as a whole gives that error for every folder.
/// Not cached, for the reason [`fix_state`] is not.
pub fn fix_states(program: &Path, folders: &[PathBuf]) -> Vec<Result<FixState, FormatError>> {
    fix_states_in(program, folders, FIX_CHUNK, TIMEOUT)
}

/// How many fix folders one program process answers for. The program works through its folders one
/// after another at about 0.3 to 1.2 seconds each, so 10 folders take 12 seconds at the slowest, well
/// inside [`TIMEOUT`]; each chunk has the whole timeout to itself, so the total grows with the number of
/// fixes and no realistic chunk can be killed for its size.
const FIX_CHUNK: usize = 10;

/// [`fix_states`] with the chunk size and the timeout of one chunk given.
fn fix_states_in(
    program: &Path,
    folders: &[PathBuf],
    chunk: usize,
    timeout: Duration,
) -> Vec<Result<FixState, FormatError>> {
    folders
        .chunks(chunk.max(1))
        .flat_map(|part| fix_states_chunk(program, part, timeout))
        .collect()
}

fn fix_states_chunk(
    program: &Path,
    folders: &[PathBuf],
    timeout: Duration,
) -> Vec<Result<FixState, FormatError>> {
    // Given one folder the program prints its object, not an array of one, so that case is the single form.
    if let [folder] = folders {
        return vec![fix_state(program, folder)];
    }
    let whole = |e: FormatError| vec![Err(e); folders.len()];
    let names: Vec<String> = folders.iter().map(|f| f.display().to_string()).collect();
    let mut args = vec!["fix-state", "--json"];
    args.extend(names.iter().map(String::as_str));
    // The program resolves each folder against the repository that holds it, so any directory will do.
    let cwd = folders[0].parent().unwrap_or(&folders[0]);
    let output = match run_within(program, cwd, &args, timeout) {
        Ok(output) => output,
        Err(e) => return whole(e),
    };
    let entries: Vec<FixEntry> = match serde_json::from_slice(&output.stdout) {
        Ok(entries) => entries,
        Err(e) => {
            return whole(FormatError::BadOutput(format!(
                "{e}{}",
                stderr_note(&output.stderr)
            )))
        }
    };
    if entries.len() != names.len() || entries.iter().zip(&names).any(|(e, n)| e.folder != *n) {
        return whole(FormatError::BadOutput(
            "the answer does not match the folders asked about".to_string(),
        ));
    }
    entries
        .into_iter()
        .map(|entry| match (entry.result, entry.error) {
            (Some(state), _) => Ok(state),
            (None, Some(message)) => Err(FormatError::CouldNotRun(message)),
            (None, None) => Err(FormatError::BadOutput(format!(
                "{}: neither a result nor an error",
                entry.folder
            ))),
        })
        .collect()
}

/// What a check depends on: the program, each checked document's name and bytes, and the marker above them.
type CheckKey = (PathBuf, Vec<(String, u64)>, u64);

fn check_cache() -> &'static Mutex<HashMap<CheckKey, Vec<Problem>>> {
    static CACHE: OnceLock<Mutex<HashMap<CheckKey, Vec<Problem>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn hash_of(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// The hash of the `.ai-sdlc.json` the program would find above `file` (it walks up from the
/// document's folder), or 0 when there is none.
fn marker_hash(file: &Path) -> u64 {
    file.ancestors()
        .skip(1)
        .map(|dir| dir.join(crate::workspace::MARKER))
        .find_map(|marker| std::fs::read(marker).ok())
        .map_or(0, |bytes| hash_of(&bytes))
}

/// Runs `node <program> <args>` in `cwd`. Exit 0 and 1 are answers (the document passes, or has
/// problems); anything else is not.
fn run(program: &Path, cwd: &Path, args: &[&str]) -> Result<process::CapturedExit, FormatError> {
    run_within(program, cwd, args, TIMEOUT)
}

/// [`run`] with the time the program may take given.
fn run_within(
    program: &Path,
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<process::CapturedExit, FormatError> {
    let mut argv = vec!["node".to_string(), program.display().to_string()];
    argv.extend(args.iter().map(|a| a.to_string()));
    RUNS.fetch_add(1, Ordering::SeqCst);
    match process::run_capture(&argv, cwd, timeout) {
        Ok(out) if matches!(out.code, Some(0 | 1)) => Ok(out),
        Ok(out) => Err(FormatError::CouldNotRun(match out.stderr.trim() {
            "" => format!(
                "exit {}",
                out.code.map_or("by signal".into(), |c| c.to_string())
            ),
            stderr => stderr.to_string(),
        })),
        Err(ProcessError::SpawnFailed(message)) if message.contains("was not found") => {
            Err(FormatError::NodeMissing)
        }
        Err(ProcessError::SpawnFailed(message)) => Err(FormatError::CouldNotRun(message)),
        Err(ProcessError::TimedOut { secs, .. }) => Err(FormatError::CouldNotRun(format!(
            "it did not finish in {secs} seconds"
        ))),
    }
}

fn stderr_note(stderr: &str) -> String {
    match stderr.trim() {
        "" => String::new(),
        text => format!(" ({text})"),
    }
}

/// The folder of the change a document belongs to (the folder of `spec.md` and `plan.md`, or the
/// one above `build/`) and the document's path below it, with forward slashes.
fn change_folder(file: &Path) -> (PathBuf, String) {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = file.parent().filter(|p| !p.as_os_str().is_empty());
    let parent = parent.unwrap_or_else(|| Path::new("."));
    if parent.file_name().is_some_and(|n| n == "build") {
        let above = parent
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        (above.to_path_buf(), format!("build/{name}"))
    } else {
        (parent.to_path_buf(), name)
    }
}

/// `<file>:<line>: <message>`, as the program prints a problem.
fn parse_problem(line: &str) -> Option<Problem> {
    let (file, rest) = line.split_once(':')?;
    let (number, message) = rest.split_once(": ")?;
    Some(Problem {
        file: file.to_string(),
        line: number.parse().ok()?,
        message: message.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_line_splits_into_file_line_and_message() {
        assert_eq!(
            parse_problem("build/app.md:14: build log entry T12: not in the plan"),
            Some(Problem {
                file: "build/app.md".into(),
                line: 14,
                message: "build log entry T12: not in the plan".into(),
            })
        );
        assert_eq!(parse_problem("nothing here"), None);
    }

    /// `n` fix folders that exist under `root`.
    fn folders_of(root: &Path, n: usize) -> Vec<PathBuf> {
        (0..n)
            .map(|i| {
                let folder = root.join(format!("2026-10-01-fix-{i:03}"));
                std::fs::create_dir_all(&folder).unwrap();
                folder
            })
            .collect()
    }

    #[test]
    fn many_fixes_are_read_in_chunks_one_after_another_f1() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = crate::testutil::fake_fix_plugin(&tmp.path().join("p"), "0.13.0");
        let folders = folders_of(tmp.path(), 45);
        let got = fix_states(&crate::build::program(&plugin), &folders);
        let calls = std::fs::read_to_string(plugin.join("format").join("calls.log")).unwrap();
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            vec![
                "fix-state 10",
                "fix-state 10",
                "fix-state 10",
                "fix-state 10",
                "fix-state 5"
            ]
        );
        assert_eq!(got.len(), 45);
        assert!(got.iter().all(|r| r.as_ref().is_ok_and(|s| s.row == 6)));
    }

    #[test]
    fn a_chunk_that_times_out_fails_only_its_own_folders_f1() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = crate::testutil::fake_fix_plugin(&tmp.path().join("p"), "0.13.0");
        let check = plugin.join("format").join("check.mjs");
        let text = std::fs::read_to_string(&check).unwrap();
        std::fs::write(
            &check,
            format!(
                "if (process.argv.some((a) => a.includes('slow'))) await new Promise((r) => setTimeout(r, 60000));\n{text}"
            ),
        )
        .unwrap();
        let mut folders = folders_of(tmp.path(), 6);
        folders[2] = tmp.path().join("2026-10-01-slow");
        std::fs::create_dir_all(&folders[2]).unwrap();
        let got = fix_states_in(
            &crate::build::program(&plugin),
            &folders,
            2,
            Duration::from_secs(2),
        );
        let failed: Vec<bool> = got.iter().map(Result::is_err).collect();
        assert_eq!(failed, vec![false, false, true, true, false, false]);
    }

    #[test]
    fn a_build_log_resolves_to_the_folder_above_build() {
        let (folder, relative) = change_folder(Path::new("x/change/build/app.md"));
        assert_eq!(folder, Path::new("x/change"));
        assert_eq!(relative, "build/app.md");
        let (folder, relative) = change_folder(Path::new("x/change/spec.md"));
        assert_eq!(folder, Path::new("x/change"));
        assert_eq!(relative, "spec.md");
    }

    fn read_review(findings: &str) -> (Vec<ParsedFinding>, Vec<Problem>) {
        let text = format!(
            "---\nlayout: 2\n---\n\n# Review findings\n\n## Review 1\n\n```yaml\nreview: 1\nreviewed_at: 2026-10-22\ncommits: {{ kata: 840fa0c }}\n```\n\n{findings}"
        );
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("build/review.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, text).unwrap();
        let program = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-format/check.mjs");
        match read(&program, &file).unwrap() {
            ReadResult::Review {
                document, problems, ..
            } => (
                document
                    .reviews
                    .into_iter()
                    .flat_map(|r| r.findings)
                    .collect(),
                problems,
            ),
            other => panic!("not a review: {other:?}"),
        }
    }

    const FULL: &str = "### F1\n\n```yaml\nid: F1\nseverity: high\nfile: a.ts\nline: 1\nrepo: kata\nconcern: convention\nrule: Use US English\n```\n\nText.\n";
    const OLD: &str =
        "### F1\n\n```yaml\nid: F1\nseverity: low\nfile: a.ts\nline: 1\n```\n\nText.\n";
    const NO_RULE: &str = "### F1\n\n```yaml\nid: F1\nseverity: low\nfile: a.ts\nline: 1\nconcern: convention\n```\n\nText.\n";

    #[test]
    fn review_finding_fields_are_read_when_present() {
        let (findings, problems) = read_review(FULL);
        assert_eq!(problems, vec![]);
        assert_eq!(findings[0].repo.as_deref(), Some("kata"));
        assert_eq!(findings[0].concern, Some(Concern::Convention));
        assert_eq!(findings[0].rule.as_deref(), Some("Use US English"));
    }

    #[test]
    fn review_finding_fields_are_none_in_an_older_review() {
        let (findings, problems) = read_review(OLD);
        assert_eq!(problems, vec![]);
        assert_eq!(findings[0].repo, None);
        assert_eq!(findings[0].concern, None);
        assert_eq!(findings[0].rule, None);
    }

    #[test]
    fn review_finding_fields_report_a_convention_without_a_rule() {
        let (_, problems) = read_review(NO_RULE);
        assert!(
            problems.iter().any(|p| p.message.contains("rule")),
            "{problems:?}"
        );
    }
}

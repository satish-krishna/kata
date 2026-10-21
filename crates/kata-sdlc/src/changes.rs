use crate::build::program;
use crate::format::{self, FormatError, ReadResult};
use crate::{branch, frontmatter, git, workspace::is_committed};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Where a change is in the intent, spec, plan flow.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Stage {
    IntentInProgress,
    IntentAwaiting,
    IntentAcceptedUncommitted,
    Rejected,
    SpecReady,
    SpecAwaiting,
    SpecAcceptedUncommitted,
    PlanReady,
    PlanAwaiting,
    PlanAcceptedUncommitted,
    PlanOutOfDate,
    /// The plan is accepted, but the format program could not read it, so its tasks are unknown. It is
    /// kept out of the build stages until it can be read.
    PlanUnreadable,
    PlanSuperseded,
    BuildReady,
    BuildStopped,
    BuildFinished,
}

/// Why an accepted or written plan cannot be built, earliest document first.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum OutOfDate {
    IntentReopened,
    SpecReopened,
    SpecPin,
    PlanPin,
    NoTasks,
}

/// Task counts of a change's plan against the committed build logs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BuildCounts {
    pub tasks: u32,
    pub finished: u32,
    pub repos: u32,
}

/// What the plan stage needs beyond the three documents' front matter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PlanFacts {
    pub spec_pin: bool,
    pub plan_pin: bool,
    pub has_tasks: bool,
    pub tasks: u32,
    pub finished: u32,
    /// The plan or the build logs could not be read (no usable plugin, no Node.js, a document the program
    /// exits on). Unknown is not empty: this never counts as "the plan has no tasks".
    pub unreadable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct DocState {
    pub exists: bool,
    pub committed: bool,
    /// Raw front-matter `status`; `Some("unknown")` when the file exists but has none.
    pub status: Option<String>,
}

impl DocState {
    fn is(&self, status: &str) -> bool {
        self.status.as_deref() == Some(status)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeInfo {
    pub system: String,
    pub change: String,
    pub intent: DocState,
    pub spec: DocState,
    pub plan: DocState,
    pub stage: Stage,
    pub build: BuildCounts,
    pub scope: String,
    pub out_of_date: Option<OutOfDate>,
    /// The plan could not be read, so its tasks and build counts are unknown; the Workbench shows why instead
    /// of a stage that claims the plan is empty.
    pub plan_unreadable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BranchInfo {
    pub current: Option<String>,
    pub others: Vec<String>,
    pub default_base: Option<String>,
}

/// Why the plan cannot be built, or `None` when it can; the first cause in document order.
/// The causes are checked in document order so the engineer is told the earliest document to settle.
pub fn out_of_date(
    intent: &DocState,
    spec: &DocState,
    _plan: &DocState,
    facts: &PlanFacts,
) -> Option<OutOfDate> {
    if !intent.is("accepted") {
        Some(OutOfDate::IntentReopened)
    } else if !spec.is("accepted") {
        Some(OutOfDate::SpecReopened)
    } else if !facts.spec_pin {
        Some(OutOfDate::SpecPin)
    } else if !facts.plan_pin {
        Some(OutOfDate::PlanPin)
    } else if !facts.has_tasks && !facts.unreadable {
        Some(OutOfDate::NoTasks)
    } else {
        None
    }
}

/// The spec's "Stage derivation and actions" table, rows in order. A reopened intent or spec keeps
/// its own stage even when a plan exists (R1.5), so the change has the actions to settle it; the
/// plan rows apply only while both documents are accepted.
pub fn derive_stage(
    intent: &DocState,
    spec: &DocState,
    plan: &DocState,
    facts: &PlanFacts,
) -> Stage {
    if intent.is("rejected") {
        return Stage::Rejected;
    }
    if intent.is("accepted") && !intent.committed {
        return Stage::IntentAcceptedUncommitted;
    }
    // A reopened intent or spec is settled at its own stage, which carries the actions to settle it.
    if plan.exists && intent.is("accepted") && spec.is("accepted") {
        if !spec.committed {
            return Stage::SpecAcceptedUncommitted;
        }
        return plan_stage(intent, spec, plan, facts);
    }
    if !intent.is("accepted") {
        return if intent.committed {
            Stage::IntentAwaiting
        } else {
            Stage::IntentInProgress
        };
    }
    if !spec.exists {
        return Stage::SpecReady;
    }
    if spec.is("accepted") && !spec.committed {
        return Stage::SpecAcceptedUncommitted;
    }
    if !spec.is("accepted") {
        return Stage::SpecAwaiting;
    }
    Stage::PlanReady
}

/// The rows of a change whose plan exists.
fn plan_stage(intent: &DocState, spec: &DocState, plan: &DocState, facts: &PlanFacts) -> Stage {
    if plan.is("superseded") {
        return Stage::PlanSuperseded;
    }
    if out_of_date(intent, spec, plan, facts).is_some() {
        return Stage::PlanOutOfDate;
    }
    if plan.is("accepted") && !plan.committed {
        return Stage::PlanAcceptedUncommitted;
    }
    if !plan.is("accepted") {
        return Stage::PlanAwaiting;
    }
    if facts.unreadable {
        return Stage::PlanUnreadable;
    }
    if facts.finished == 0 {
        Stage::BuildReady
    } else if facts.finished >= facts.tasks {
        Stage::BuildFinished
    } else {
        Stage::BuildStopped
    }
}

/// `^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$`, matched by hand.
pub(crate) fn is_change_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 12 {
        return false;
    }
    let date_ok = b[..10].iter().enumerate().all(|(i, c)| {
        if i == 4 || i == 7 {
            *c == b'-'
        } else {
            c.is_ascii_digit()
        }
    });
    date_ok
        && b[10] == b'-'
        && b[11..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A single normal path component: not empty, not `.`/`..`, no separators.
pub(crate) fn is_safe_system(system: &str) -> bool {
    use std::path::Component;
    let mut parts = Path::new(system).components();
    matches!(parts.next(), Some(Component::Normal(_)))
        && parts.next().is_none()
        && !system.contains(['/', '\\', ':'])
}

fn doc_state(master: &Path, system: &str, change: &str, file: &str) -> DocState {
    let rel = format!("intent/{system}/{change}/{file}");
    match std::fs::read_to_string(master.join(&rel)) {
        Ok(text) => DocState {
            exists: true,
            committed: is_committed(master, &rel),
            status: Some(frontmatter::field(&text, "status").unwrap_or_else(|| "unknown".into())),
        },
        Err(_) => DocState::default(),
    }
}

/// The plan's tasks from the working tree, the finished ones from the committed build logs, and
/// whether both source pins hold. Both are read by the format program in `plugin`. Without a usable
/// plugin, or when the program cannot run or read a document, the facts are marked unreadable: the counts
/// are unknown, not zero. A plan that is not committed yet is not unreadable; it has no finished tasks.
fn plan_facts(
    plugin: Option<&Path>,
    master: &Path,
    system: &str,
    change: &str,
) -> (PlanFacts, BuildCounts) {
    let plan_file = master.join(format!("intent/{system}/{change}/plan.md"));
    let read = plugin.map(|p| crate::format::read(&crate::build::program(p), &plan_file));
    let (tasks, mut unreadable) = match read {
        Some(Ok(crate::format::ReadResult::Plan { document, .. })) => (document.tasks, false),
        _ => (Vec::new(), true),
    };
    let mut repos: Vec<&str> = tasks.iter().map(|t| t.repo.as_str()).collect();
    repos.sort_unstable();
    repos.dedup();
    let finished = match plugin.map(|p| crate::build::status(p, master, system, change)) {
        Some(Ok(status)) => status.tasks.iter().filter(|t| t.row.is_some()).count() as u32,
        Some(Err(e)) if !crate::build::is_unreadable(&e) => 0,
        _ => {
            unreadable = true;
            0
        }
    };
    let counts = BuildCounts {
        tasks: tasks.len() as u32,
        finished,
        repos: repos.len() as u32,
    };
    let facts = PlanFacts {
        spec_pin: crate::pins::spec_pin_holds(master, system, change),
        plan_pin: crate::pins::plan_pin_holds(master, system, change),
        has_tasks: !tasks.is_empty(),
        tasks: counts.tasks,
        finished,
        unreadable,
    };
    (facts, counts)
}

/// The changes of `system` in the master repo, newest folder name first.
pub fn list(plugin: Option<&Path>, master: &Path, system: &str) -> Vec<ChangeInfo> {
    if !is_safe_system(system) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(master.join("intent").join(system)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_change_name(n))
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    names
        .into_iter()
        .map(|change| {
            let intent = doc_state(master, system, &change, "intent.md");
            let spec = doc_state(master, system, &change, "spec.md");
            let plan = doc_state(master, system, &change, "plan.md");
            let (facts, build) = if plan.exists {
                plan_facts(plugin, master, system, &change)
            } else {
                (PlanFacts::default(), BuildCounts::default())
            };
            let stage = derive_stage(&intent, &spec, &plan, &facts);
            let out_of_date = if plan.exists && stage == Stage::PlanOutOfDate {
                out_of_date(&intent, &spec, &plan, &facts)
            } else {
                None
            };
            let scope = crate::decide::change_scope(master, system, &change);
            ChangeInfo {
                system: system.to_string(),
                change,
                intent,
                spec,
                plan,
                stage,
                build,
                scope,
                out_of_date,
                plan_unreadable: facts.unreadable,
            }
        })
        .collect()
}

pub use crate::branch::current_branch;

/// `change/*` branches other than the current one and `change/pending-*`, without the `change/` prefix.
pub fn other_change_branches(master: &Path) -> Vec<String> {
    let current = current_branch(master);
    git::run(
        master,
        &["branch", "--list", "change/*", "--format=%(refname:short)"],
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|b| !b.is_empty() && Some(*b) != current.as_deref())
    .filter_map(|b| b.strip_prefix("change/"))
    .filter(|b| !b.starts_with("pending-"))
    .map(str::to_string)
    .collect()
}

/// Read `intent`, `spec`, or `plan` of a change from the working tree.
pub fn read_doc(master: &Path, system: &str, change: &str, doc: &str) -> Option<String> {
    if !matches!(doc, "intent" | "spec" | "plan")
        || !is_change_name(change)
        || !is_safe_system(system)
    {
        return None;
    }
    std::fs::read_to_string(
        master
            .join("intent")
            .join(system)
            .join(change)
            .join(format!("{doc}.md")),
    )
    .ok()
}

/// The change's spec or plan as the file holds it now, read by the format program in `plugin` (the
/// ai-sdlc plugin folder): the same read the checks make, so what the Workbench shows is what they
/// check. `None` for any other document, a bad name, or a file that is not there.
pub fn read_parsed(
    plugin: &Path,
    master: &Path,
    system: &str,
    change: &str,
    doc: &str,
) -> Result<Option<ReadResult>, FormatError> {
    if !matches!(doc, "spec" | "plan") || !is_change_name(change) || !is_safe_system(system) {
        return Ok(None);
    }
    let file = master
        .join("intent")
        .join(system)
        .join(change)
        .join(format!("{doc}.md"));
    if !file.is_file() {
        return Ok(None);
    }
    format::read(&program(plugin), &file).map(Some)
}

pub fn branch_info(master: &Path) -> BranchInfo {
    BranchInfo {
        current: current_branch(master),
        others: other_change_branches(master),
        default_base: branch::default_base(master),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    fn doc(committed: bool, status: &str) -> DocState {
        DocState {
            exists: true,
            committed,
            status: Some(status.into()),
        }
    }
    fn none() -> DocState {
        DocState::default()
    }

    /// Facts of a plan whose pins hold, with `tasks` tasks of which `finished` are recorded.
    fn facts(tasks: u32, finished: u32) -> PlanFacts {
        PlanFacts {
            spec_pin: true,
            plan_pin: true,
            has_tasks: tasks > 0,
            tasks,
            finished,
            unreadable: false,
        }
    }

    #[test]
    fn derive_stage_table() {
        let none_f = PlanFacts::default();
        let d = |i: &DocState, s: &DocState, p: &DocState| derive_stage(i, s, p, &none_f);
        assert_eq!(
            d(&doc(false, "draft"), &none(), &none()),
            Stage::IntentInProgress
        );
        assert_eq!(
            d(&doc(true, "draft"), &none(), &none()),
            Stage::IntentAwaiting
        );
        assert_eq!(
            d(&doc(false, "accepted"), &none(), &none()),
            Stage::IntentAcceptedUncommitted
        );
        assert_eq!(d(&doc(true, "rejected"), &none(), &none()), Stage::Rejected);
        let acc = doc(true, "accepted");
        assert_eq!(d(&acc, &none(), &none()), Stage::SpecReady);
        assert_eq!(
            d(&acc, &doc(true, "ready for product owner review"), &none()),
            Stage::SpecAwaiting
        );
        assert_eq!(
            d(&acc, &doc(false, "accepted"), &none()),
            Stage::SpecAcceptedUncommitted
        );
        let spec = doc(true, "accepted");
        assert_eq!(d(&acc, &spec, &none()), Stage::PlanReady);
        assert_eq!(
            d(&acc, &spec, &doc(true, "superseded")),
            Stage::PlanSuperseded
        );
    }

    #[test]
    fn derive_stage_written_plan_awaits_acceptance_r1_1() {
        let acc = doc(true, "accepted");
        let f = facts(2, 0);
        assert_eq!(
            derive_stage(&acc, &acc, &doc(true, "draft"), &f),
            Stage::PlanAwaiting
        );
        assert_eq!(
            derive_stage(&acc, &acc, &doc(false, "accepted"), &f),
            Stage::PlanAcceptedUncommitted
        );
    }

    #[test]
    fn derive_stage_superseded_plan_cannot_build_r1_3() {
        let acc = doc(true, "accepted");
        let sup = doc(true, "superseded");
        assert_eq!(
            derive_stage(&acc, &acc, &sup, &facts(2, 0)),
            Stage::PlanSuperseded
        );
        // A reopened intent is settled first; the plan is rewritten once it is accepted again.
        assert_eq!(
            derive_stage(&doc(true, "draft"), &acc, &sup, &facts(2, 0)),
            Stage::IntentAwaiting
        );
    }

    #[test]
    fn derive_stage_broken_pins_are_out_of_date_r1_4() {
        let acc = doc(true, "accepted");
        let plan = doc(true, "accepted");
        let broken_plan = PlanFacts {
            plan_pin: false,
            ..facts(2, 0)
        };
        assert_eq!(
            derive_stage(&acc, &acc, &plan, &broken_plan),
            Stage::PlanOutOfDate
        );
        assert_eq!(
            out_of_date(&acc, &acc, &plan, &broken_plan),
            Some(OutOfDate::PlanPin)
        );
        let broken_spec = PlanFacts {
            spec_pin: false,
            ..facts(2, 0)
        };
        assert_eq!(
            derive_stage(&acc, &acc, &plan, &broken_spec),
            Stage::PlanOutOfDate
        );
        assert_eq!(
            out_of_date(&acc, &acc, &plan, &broken_spec),
            Some(OutOfDate::SpecPin)
        );
        // The spec's pin is named first when both are broken.
        let both = PlanFacts {
            spec_pin: false,
            plan_pin: false,
            ..facts(2, 0)
        };
        assert_eq!(
            out_of_date(&acc, &acc, &plan, &both),
            Some(OutOfDate::SpecPin)
        );
        let no_tasks = facts(0, 0);
        assert_eq!(
            derive_stage(&acc, &acc, &doc(true, "draft"), &no_tasks),
            Stage::PlanOutOfDate
        );
        assert_eq!(
            out_of_date(&acc, &acc, &doc(true, "draft"), &no_tasks),
            Some(OutOfDate::NoTasks)
        );
        assert_eq!(out_of_date(&acc, &acc, &plan, &facts(2, 0)), None);
    }

    #[test]
    fn derive_stage_reopened_intent_or_spec_r1_5() {
        let acc = doc(true, "accepted");
        let plan = doc(true, "accepted");
        let f = facts(2, 1);
        let draft = doc(true, "draft");
        // A reopened document is settled at its own stage, which carries the actions to settle it.
        assert_eq!(derive_stage(&draft, &acc, &plan, &f), Stage::IntentAwaiting);
        assert_eq!(
            derive_stage(&doc(false, "draft"), &acc, &plan, &f),
            Stage::IntentInProgress
        );
        assert_eq!(
            derive_stage(&draft, &acc, &doc(true, "superseded"), &f),
            Stage::IntentAwaiting
        );
        assert_eq!(derive_stage(&acc, &draft, &plan, &f), Stage::SpecAwaiting);
        assert_eq!(
            derive_stage(&acc, &draft, &doc(true, "superseded"), &f),
            Stage::SpecAwaiting
        );
        assert_eq!(
            out_of_date(&draft, &acc, &plan, &f),
            Some(OutOfDate::IntentReopened)
        );
        assert_eq!(
            out_of_date(&acc, &draft, &plan, &f),
            Some(OutOfDate::SpecReopened)
        );
        // The intent is named first when both are reopened.
        assert_eq!(
            out_of_date(&draft, &draft, &plan, &f),
            Some(OutOfDate::IntentReopened)
        );
    }

    #[test]
    fn derive_stage_build_rows_r14_1() {
        let acc = doc(true, "accepted");
        assert_eq!(
            derive_stage(&acc, &acc, &acc, &facts(2, 0)),
            Stage::BuildReady
        );
        assert_eq!(
            derive_stage(&acc, &acc, &acc, &facts(2, 1)),
            Stage::BuildStopped
        );
        assert_eq!(
            derive_stage(&acc, &acc, &acc, &facts(2, 2)),
            Stage::BuildFinished
        );
    }

    #[test]
    fn list_reads_counts_scope_and_pins() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        testutil::commit_file(
            &repo,
            &format!("{dir}/intent.md"),
            "---\nstatus: accepted\nscope: sdlc\n---\nintent\n",
            "intent",
        );
        let intent_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/spec.md"),
            &format!("---\nstatus: accepted\nsource_intent_commit: {intent_pin}\n---\nspec\n"),
            "spec",
        );
        let spec_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/plan.md"),
            &format!(
                "---\nstatus: accepted\nsource_spec_commit: {spec_pin}\n---\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n\n### T2: Two (`app`)\n\n- **Depends on:** T1\n"
            ),
            "plan",
        );
        testutil::commit_file(
            &repo,
            &format!("{dir}/build/app.md"),
            "# Build log: app\n\n| Task | Commits | Departure |\n|---|---|---|\n| T1 | `a111111` | none |\n",
            "log",
        );
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].stage, Stage::BuildStopped);
        assert_eq!(
            got[0].build,
            BuildCounts {
                tasks: 2,
                finished: 1,
                repos: 1
            }
        );
        assert_eq!(got[0].scope, "sdlc");
        assert_eq!(got[0].out_of_date, None);

        // Changing the spec breaks the plan's pin.
        testutil::commit_file(
            &repo,
            &format!("{dir}/spec.md"),
            "---\nstatus: accepted\n---\nspec v2\n",
            "spec v2",
        );
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        assert_eq!(got[0].stage, Stage::PlanOutOfDate);
        assert_eq!(got[0].out_of_date, Some(OutOfDate::SpecPin));
    }

    /// F5: a plan the program could not read (no usable plugin here) is not a plan with no tasks.
    #[test]
    fn an_unreadable_plan_is_not_a_plan_with_no_tasks_f5() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        testutil::commit_file(
            &repo,
            &format!("{dir}/intent.md"),
            "---
status: accepted
---
intent
",
            "intent",
        );
        let intent_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/spec.md"),
            &format!(
                "---
status: accepted
source_intent_commit: {intent_pin}
---
spec
"
            ),
            "spec",
        );
        let spec_pin = git::run(&repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            &repo,
            &format!("{dir}/plan.md"),
            &format!(
                "---
status: accepted
source_spec_commit: {spec_pin}
---

## Tasks

### T1: One (`app`)

- **Depends on:** none
"
            ),
            "plan",
        );
        // No plugin: nothing could read the plan.
        let got = list(None, &repo, "claims");
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_ne!(
            json["out_of_date"],
            serde_json::json!("no-tasks"),
            "an unreadable plan was reported as having no tasks"
        );
        assert_eq!(json["plan_unreadable"], serde_json::json!(true));
        // With the plugin, the same plan reads and is not flagged.
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["plan_unreadable"], serde_json::json!(false));
    }

    /// An accepted intent and spec in `repo`; returns the spec commit a plan pins.
    fn accepted_spec(repo: &Path, dir: &str) -> String {
        testutil::commit_file(
            repo,
            &format!("{dir}/intent.md"),
            "---
status: accepted
---
intent
",
            "intent",
        );
        let intent_pin = git::run(repo, &["rev-parse", "HEAD"]).unwrap();
        testutil::commit_file(
            repo,
            &format!("{dir}/spec.md"),
            &format!(
                "---
status: accepted
source_intent_commit: {intent_pin}
---
spec
"
            ),
            "spec",
        );
        git::run(repo, &["rev-parse", "HEAD"]).unwrap()
    }

    /// F20: a written plan that is not committed yet has no tasks, which is a fact and not a failure to read.
    #[test]
    fn an_uncommitted_empty_plan_has_no_tasks_f20() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        let spec_pin = accepted_spec(&repo, dir);
        testutil::write(
            &repo,
            &format!("{dir}/plan.md"),
            &format!(
                "---
status: draft
source_spec_commit: {spec_pin}
---

## Tasks
"
            ),
        );
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["plan_unreadable"], serde_json::json!(false));
        assert_eq!(json["stage"], serde_json::json!("plan-out-of-date"));
        assert_eq!(json["out_of_date"], serde_json::json!("no-tasks"));
    }

    /// F20: an accepted plan the program could not read is neither a plan with no tasks nor a build to start.
    #[test]
    fn an_unreadable_accepted_plan_is_kept_out_of_the_build_stages_f20() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        let spec_pin = accepted_spec(&repo, dir);
        testutil::commit_file(
            &repo,
            &format!("{dir}/plan.md"),
            &format!(
                "---
status: accepted
source_spec_commit: {spec_pin}
---

## Tasks

### T1: One (`app`)

- **Depends on:** none
"
            ),
            "plan",
        );
        // No plugin: nothing could read the plan.
        let got = list(None, &repo, "claims");
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["plan_unreadable"], serde_json::json!(true));
        assert_eq!(json["stage"], serde_json::json!("plan-unreadable"));
        // With the plugin the same plan is a build to start.
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        assert_eq!(got[0].stage, Stage::BuildReady);
    }

    #[test]
    fn list_skips_non_change_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for d in ["context", "templates", "notes"] {
            testutil::commit_file(&repo, &format!("intent/claims/{d}/x.md"), "x\n", d);
        }
        testutil::commit_file(
            &repo,
            "intent/claims/2026-10-12-fnol-photo-upload/intent.md",
            "---\nstatus: draft\n---\n",
            "intent",
        );
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].change, "2026-10-12-fnol-photo-upload");
        assert_eq!(got[0].stage, Stage::IntentAwaiting);
    }

    #[test]
    fn list_sorts_descending() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for c in ["2026-10-01-a", "2026-10-09-b"] {
            testutil::commit_file(
                &repo,
                &format!("intent/s/{c}/intent.md"),
                "---\nstatus: draft\n---\n",
                c,
            );
        }
        let names: Vec<_> = list(Some(testutil::plugin_dir()), &repo, "s")
            .into_iter()
            .map(|c| c.change)
            .collect();
        assert_eq!(names, ["2026-10-09-b", "2026-10-01-a"]);
    }

    #[test]
    fn missing_front_matter_reads_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(
            &repo,
            "intent/s/2026-10-12-x/intent.md",
            "no front matter\n",
            "i",
        );
        let got = list(Some(testutil::plugin_dir()), &repo, "s");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].intent.status.as_deref(), Some("unknown"));
        assert_eq!(got[0].stage, Stage::IntentAwaiting);
    }

    #[test]
    fn branches() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        for b in ["change/a", "change/b", "change/pending-20261018T000000Z"] {
            git::run(&repo, &["branch", b]).unwrap();
        }
        git::run(&repo, &["checkout", "-q", "change/a"]).unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("change/a"));
        assert_eq!(other_change_branches(&repo), ["b"]);
        let info = branch_info(&repo);
        assert_eq!(info.default_base.as_deref(), Some("main"));
    }

    #[test]
    fn detached_head_has_no_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["checkout", "-q", "--detach"]).unwrap();
        assert_eq!(current_branch(&repo), None);
    }

    #[test]
    fn unborn_head_has_no_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("u");
        std::fs::create_dir_all(&repo).unwrap();
        git::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
        assert_eq!(current_branch(&repo), None);
        assert_eq!(branch::default_base(&repo), None);
        assert!(other_change_branches(&repo).is_empty());
    }

    #[test]
    fn read_parsed_reads_a_spec_and_a_plan_and_refuses_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let spec = include_str!("../tests/ai-sdlc-format/examples/spec/2/valid.md");
        let plan = include_str!("../tests/ai-sdlc-format/examples/plan/2/valid.md");
        testutil::write(&repo, "intent/s/2026-10-12-x/spec.md", spec);
        testutil::write(&repo, "intent/s/2026-10-12-x/plan.md", plan);
        let plugin = testutil::plugin_dir();
        let read = |system: &str, change: &str, doc: &str| {
            read_parsed(plugin, &repo, system, change, doc).unwrap()
        };
        match read("s", "2026-10-12-x", "spec") {
            Some(ReadResult::Spec { document, .. }) => assert!(!document.requirements.is_empty()),
            other => panic!("not a spec: {other:?}"),
        }
        match read("s", "2026-10-12-x", "plan") {
            Some(ReadResult::Plan { document, .. }) => assert!(!document.tasks.is_empty()),
            other => panic!("not a plan: {other:?}"),
        }
        assert_eq!(read("s", "2026-10-12-x", "intent"), None);
        assert_eq!(read("s", "2026-10-12-y", "spec"), None);
        assert_eq!(read("s", "../..", "spec"), None);
        assert_eq!(read("..", "2026-10-12-x", "spec"), None);
    }

    #[test]
    fn read_doc_reads_and_rejects_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(&repo, "intent/s/2026-10-12-x/spec.md", "hello\n", "s");
        assert_eq!(
            read_doc(&repo, "s", "2026-10-12-x", "spec").as_deref(),
            Some("hello\n")
        );
        assert_eq!(read_doc(&repo, "s", "2026-10-12-x", "../README"), None);
        assert_eq!(read_doc(&repo, "s", "../..", "spec"), None);
        for bad in ["../..", "..", ".", "", "a/b", "a\\b", "C:", "C:foo"] {
            assert_eq!(read_doc(&repo, bad, "2026-10-12-x", "spec"), None, "{bad}");
            assert!(
                list(Some(testutil::plugin_dir()), &repo, bad).is_empty(),
                "{bad}"
            );
        }
    }
}

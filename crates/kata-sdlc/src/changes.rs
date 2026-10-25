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
    FixInProgress,
    FixUnsettled,
    FixAwaiting,
    FixAccepting,
    /// A fix on a machine whose ai-sdlc plugin is older than 0.13.0: it is a fix, and where it stands
    /// cannot be read.
    FixNeedsPlugin,
}

/// Which pipeline a change is on: the full intent, spec, plan flow, or the light track a fix takes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum Track {
    Full,
    Fix,
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
    /// The `status` of the `HEAD` copy, as the format program reports it for a fix; `None` when the document is
    /// not in `HEAD`, and always `None` for a full-pipeline change.
    pub head_status: Option<String>,
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
    /// Why, in the format program's own words (or that no plugin was found), when `plan_unreadable`; null otherwise.
    /// The change list words its notice from this, so it never blames Node.js for a layout it does not read.
    pub plan_unreadable_reason: Option<String>,
    pub track: Track,
    /// The row of the format program's fix-state table the fix stands at (1 to 8, or one this Workbench
    /// does not know). `None` for a full-pipeline change, a fix the program could not answer for, and a
    /// fix on a plugin too old to ask.
    pub fix_row: Option<u8>,
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

/// The track an intent's front matter names; anything but `fix` is the full pipeline.
pub fn track(intent_text: &str) -> Track {
    match frontmatter::field(intent_text, "track").as_deref() {
        Some("fix") => Track::Fix,
        _ => Track::Full,
    }
}

/// The stage of a fix from the row of the fix-state table the format program computed: rows 1 to 7
/// are stages of their own and row 8 (all three documents accepted) gives the plan rows. Any other row is a
/// table this Workbench does not know, so nothing is offered.
fn fix_stage(
    row: u8,
    intent: &DocState,
    spec: &DocState,
    plan: &DocState,
    plan_facts: &PlanFacts,
) -> Stage {
    match row {
        1 => Stage::Rejected,
        2 => Stage::FixUnsettled,
        3 => Stage::FixInProgress,
        4 | 5 => Stage::FixAccepting,
        6 | 7 => Stage::FixAwaiting,
        8 => plan_stage(intent, spec, plan, plan_facts),
        _ => Stage::FixUnsettled,
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

/// The state of one document. `head_status` is what the format program said about the `HEAD` copy (a fix
/// only); a full-pipeline change has none.
fn doc_state(
    master: &Path,
    system: &str,
    change: &str,
    file: &str,
    head_status: Option<String>,
) -> DocState {
    let rel = format!("intent/{system}/{change}/{file}");
    match std::fs::read_to_string(master.join(&rel)) {
        Ok(text) => DocState {
            exists: true,
            committed: is_committed(master, &rel),
            status: Some(frontmatter::field(&text, "status").unwrap_or_else(|| "unknown".into())),
            head_status,
        },
        Err(_) => DocState {
            head_status,
            ..DocState::default()
        },
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
) -> (PlanFacts, BuildCounts, Option<String>) {
    let plan_file = master.join(format!("intent/{system}/{change}/plan.md"));
    let read = plugin.map(|p| crate::format::read(&crate::build::program(p), &plan_file));
    let mut reason = None;
    let tasks = match read {
        Some(Ok(crate::format::ReadResult::Plan { document, .. })) => document.tasks,
        Some(Ok(_)) => {
            reason = Some("the plan was not read as a plan".to_string());
            Vec::new()
        }
        Some(Err(e)) => {
            reason = Some(e.to_string());
            Vec::new()
        }
        None => {
            reason = Some("the ai-sdlc plugin was not found".to_string());
            Vec::new()
        }
    };
    let mut repos: Vec<&str> = tasks.iter().map(|t| t.repo.as_str()).collect();
    repos.sort_unstable();
    repos.dedup();
    let finished = match plugin.map(|p| crate::build::status(p, master, system, change)) {
        Some(Ok(status)) => status.tasks.iter().filter(|t| t.row.is_some()).count() as u32,
        Some(Err(e)) if !crate::build::is_unreadable(&e) => 0,
        other => {
            // The plan's own reason, when it has one, comes first; a log's comes only if nothing else did.
            if reason.is_none() {
                reason = Some(match other {
                    Some(Err(e)) => e.stderr,
                    _ => "the build logs could not be read".to_string(),
                });
            }
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
        unreadable: reason.is_some(),
    };
    (facts, counts, reason)
}

/// Why a fix cannot be read on a plugin older than [`crate::plugin::LIGHT_TRACK_VERSION`].
const NEEDS_PLUGIN: &str = "Needs ai-sdlc 0.13.0 or later.";

/// The folder of one change in the master repo.
fn change_dir(master: &Path, system: &str, change: &str) -> std::path::PathBuf {
    master.join("intent").join(system).join(change)
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
    let tracks: Vec<Track> = names
        .iter()
        .map(|change| {
            std::fs::read_to_string(change_dir(master, system, change).join("intent.md"))
                .map(|t| track(&t))
                .unwrap_or(Track::Full)
        })
        .collect();
    // Every fix of the system is read in one program process, and only by a plugin that knows the light track.
    let needs_plugin = plugin.is_some_and(|p| {
        !crate::plugin::version(p).is_some_and(|v| crate::plugin::light_track(&v))
    });
    let fix_folders: Vec<std::path::PathBuf> = names
        .iter()
        .zip(&tracks)
        .filter(|(_, t)| **t == Track::Fix)
        .map(|(change, _)| change_dir(master, system, change))
        .collect();
    let mut fix_reads = match plugin {
        Some(_) if needs_plugin => Vec::new(),
        Some(p) => format::fix_states(&crate::build::program(p), &fix_folders)
            .into_iter()
            .map(|r| Some(r.map_err(|e| e.to_string())))
            .collect(),
        None => Vec::new(),
    }
    .into_iter();
    names
        .into_iter()
        .zip(tracks)
        .map(|(change, track_of)| {
            // A fix is read by the format program: where it stands, and what each document says in `HEAD`.
            let fix: Option<Result<format::FixState, String>> = (track_of == Track::Fix).then(|| {
                if needs_plugin {
                    Err(NEEDS_PLUGIN.to_string())
                } else if plugin.is_none() {
                    Err("the ai-sdlc plugin was not found".to_string())
                } else {
                    fix_reads
                        .next()
                        .flatten()
                        .unwrap_or_else(|| Err("the format program gave no answer".to_string()))
                }
            });
            let heads = |pick: fn(&format::FixFacts) -> &format::FixDocumentFacts| match &fix {
                Some(Ok(state)) => pick(&state.facts).head_status.clone(),
                _ => None,
            };
            let intent = doc_state(master, system, &change, "intent.md", heads(|f| &f.intent));
            let spec = doc_state(master, system, &change, "spec.md", heads(|f| &f.spec));
            let plan = doc_state(master, system, &change, "plan.md", heads(|f| &f.plan));
            let (mut facts, build, mut plan_unreadable_reason) = if plan.exists {
                plan_facts(plugin, master, system, &change)
            } else {
                (PlanFacts::default(), BuildCounts::default(), None)
            };
            let mut fix_row = None;
            let stage = match &fix {
                Some(Ok(state)) => {
                    fix_row = Some(state.row);
                    if !(1..=8).contains(&state.row) {
                        facts.unreadable = true;
                        plan_unreadable_reason.get_or_insert_with(|| {
                            format!("the format program reported fix row {}, which this Workbench does not know", state.row)
                        });
                    }
                    fix_stage(state.row, &intent, &spec, &plan, &facts)
                }
                Some(Err(message)) => {
                    // The row is unknown, so nothing is offered; the notice carries the program's words.
                    facts.unreadable = true;
                    plan_unreadable_reason.get_or_insert_with(|| message.clone());
                    if needs_plugin {
                        Stage::FixNeedsPlugin
                    } else {
                        Stage::FixUnsettled
                    }
                }
                None => derive_stage(&intent, &spec, &plan, &facts),
            };
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
                plan_unreadable_reason,
                track: track_of,
                fix_row,
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
            head_status: None,
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
    fn track_reads_fix_and_nothing_else() {
        assert_eq!(
            track("---\nstatus: draft\ntrack: fix\n---\nx\n"),
            Track::Fix
        );
        assert_eq!(
            track("---\nstatus: draft\ntrack: full\n---\nx\n"),
            Track::Full
        );
        assert_eq!(
            track("---\nstatus: draft\ntrack: Fix\n---\nx\n"),
            Track::Full
        );
        assert_eq!(track("---\nstatus: draft\ntrack:\n---\nx\n"), Track::Full);
        assert_eq!(track("---\nstatus: draft\n---\nx\n"), Track::Full);
        assert_eq!(track("no front matter\ntrack: fix\n"), Track::Full);
    }

    const FIX_DIR: &str = "intent/claims/2026-10-23-fix-it";

    fn fix_intent(status: &str) -> String {
        format!("---\nstatus: {status}\ntrack: fix\n---\nintent\n")
    }
    fn pinned_spec(status: &str, pin: &str) -> String {
        format!("---\nstatus: {status}\nsource_intent_commit: {pin}\n---\nspec\n")
    }
    fn pinned_plan(status: &str, pin: &str) -> String {
        format!(
            "---\nstatus: {status}\nsource_spec_commit: {pin}\n---\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
        )
    }
    fn last_commit_of(repo: &Path, rel: &str) -> String {
        git::run(repo, &["log", "-1", "--format=%H", "--", rel]).unwrap()
    }
    /// Commit the three drafts the way the fix skill does, pins left as `pending acceptance`.
    fn commit_fix_drafts(repo: &Path) {
        let draft = |file: &str, text: String, msg: &str| {
            testutil::commit_file(repo, &format!("{FIX_DIR}/{file}"), &text, msg);
        };
        draft("intent.md", fix_intent("draft"), "draft intent");
        draft(
            "spec.md",
            pinned_spec("draft", "pending acceptance"),
            "draft spec",
        );
        draft(
            "plan.md",
            pinned_plan("draft", "pending acceptance"),
            "draft plan",
        );
    }
    /// The subject the fix skill gives an acceptance commit.
    fn accept_subject(document: &str) -> String {
        format!("docs(sdlc): accept {document} 2026-10-23-fix-it")
    }
    /// The fix skill's section 6: accept the intent, pin the spec to that commit and accept it, then
    /// pin the plan to the spec's commit and accept it, one commit each.
    fn accept_fix_in_steps(repo: &Path, intent: bool, spec: bool, plan: bool) {
        let at = |file: &str| format!("{FIX_DIR}/{file}");
        if intent {
            testutil::commit_file(
                repo,
                &at("intent.md"),
                &fix_intent("accepted"),
                &accept_subject("intent"),
            );
        }
        if spec {
            let pin = last_commit_of(repo, &at("intent.md"));
            testutil::commit_file(
                repo,
                &at("spec.md"),
                &pinned_spec("accepted", &pin),
                &accept_subject("spec"),
            );
        }
        if plan {
            let pin = last_commit_of(repo, &at("spec.md"));
            testutil::commit_file(
                repo,
                &at("plan.md"),
                &pinned_plan("accepted", &pin),
                &accept_subject("plan"),
            );
        }
    }
    fn only_change(repo: &Path) -> ChangeInfo {
        let got = list(Some(testutil::plugin_dir()), repo, "claims");
        assert_eq!(got.len(), 1);
        got.into_iter().next().unwrap()
    }

    #[test]
    fn fix_stage_table() {
        let tmp = tempfile::tempdir().unwrap();
        let mut n = 0;
        let mut fresh = || {
            n += 1;
            testutil::repo(tmp.path(), &format!("m{n}"))
        };
        let at = |file: &str| format!("{FIX_DIR}/{file}");
        let draft_plan = |repo: &Path| pinned_plan("draft", &last_commit_of(repo, &at("spec.md")));

        // Row 1: a rejected intent is rejected whatever else holds.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::commit_file(&repo, &at("intent.md"), &fix_intent("rejected"), "reject");
        assert_eq!(only_change(&repo).stage, Stage::Rejected);

        // Row 2: a status the workflow never leaves on a fix (a superseded plan).
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::commit_file(
            &repo,
            &at("plan.md"),
            &pinned_plan("superseded", "pending acceptance"),
            "supersede",
        );
        assert_eq!(only_change(&repo).stage, Stage::FixUnsettled);

        // Row 2: a spec accepted while the intent is still a draft.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::commit_file(
            &repo,
            &at("spec.md"),
            &pinned_spec("accepted", "pending acceptance"),
            &accept_subject("spec"),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixUnsettled);

        // Row 3: a plan not yet recorded.
        let repo = fresh();
        testutil::commit_file(&repo, &at("intent.md"), &fix_intent("draft"), "draft");
        testutil::commit_file(
            &repo,
            &at("spec.md"),
            &pinned_spec("draft", "pending acceptance"),
            "draft",
        );
        testutil::write(
            &repo,
            &at("plan.md"),
            &pinned_plan("draft", "pending acceptance"),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 3: an engineer's edit to a draft's body.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::write(
            &repo,
            &at("plan.md"),
            &format!("{}\nA note.\n", draft_plan(&repo)),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 3: an edit to an accepted intent.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, false, false);
        testutil::write(
            &repo,
            &at("intent.md"),
            &format!("{}A note.\n", fix_intent("accepted")),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 4: an uncommitted `status: accepted` on the intent only.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::write(&repo, &at("intent.md"), &fix_intent("accepted"));
        assert_eq!(only_change(&repo).stage, Stage::FixAccepting);

        // Row 5: some accepted, and the last recorded step was one of those acceptances.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, true, false);
        assert_eq!(only_change(&repo).stage, Stage::FixAccepting);

        // Row 6: some accepted, the last recorded step was a redraft.
        testutil::commit_file(
            &repo,
            &at("plan.md"),
            &draft_plan(&repo),
            "docs(sdlc): draft fix 2026-10-23-fix-it",
        );
        assert_eq!(only_change(&repo).stage, Stage::FixAwaiting);

        // Row 6: some accepted, the last recorded step was an engineer's own commit.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, true, false);
        testutil::commit_file(
            &repo,
            &at("plan.md"),
            &format!("{}\nA note.\n", draft_plan(&repo)),
            "chore: tidy",
        );
        assert_eq!(only_change(&repo).stage, Stage::FixAwaiting);

        // Row 7: all three drafted, none accepted.
        let repo = fresh();
        commit_fix_drafts(&repo);
        assert_eq!(only_change(&repo).stage, Stage::FixAwaiting);

        // Row 8: all three accepted gives the plan rows.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, true, true);
        assert_eq!(only_change(&repo).stage, Stage::BuildReady);
    }

    #[test]
    fn fix_stage_review_three_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let mut n = 0;
        let mut fresh = || {
            n += 1;
            testutil::repo(tmp.path(), &format!("r{n}"))
        };
        let at = |file: &str| format!("{FIX_DIR}/{file}");

        // Row 4: own lines written with CRLF line endings are still own lines.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::write(
            &repo,
            &at("intent.md"),
            &fix_intent("accepted").replace('\n', "\r\n"),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixAccepting);

        // Row 3: all three documents untracked.
        let repo = fresh();
        testutil::write(&repo, &at("intent.md"), &fix_intent("draft"));
        testutil::write(
            &repo,
            &at("spec.md"),
            &pinned_spec("draft", "pending acceptance"),
        );
        testutil::write(
            &repo,
            &at("plan.md"),
            &pinned_plan("draft", "pending acceptance"),
        );
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 6: a leading run, and the latest commit is a `reopen fix` redraft.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, false, false);
        testutil::commit_file(
            &repo,
            &at("spec.md"),
            &format!(
                "{}\nReworded.\n",
                pinned_spec("draft", "pending acceptance")
            ),
            "docs(sdlc): reopen fix 2026-10-23-fix-it",
        );
        assert_eq!(only_change(&repo).stage, Stage::FixAwaiting);

        // Row 2: a document not in HEAD while another is accepted in HEAD.
        let repo = fresh();
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, false, false);
        git::run(&repo, &["rm", "-q", "--", &at("plan.md")]).unwrap();
        git::run(&repo, &["commit", "-q", "-m", "drop the plan"]).unwrap();
        assert_eq!(only_change(&repo).stage, Stage::FixUnsettled);

        // Row 3: a half-written rejection is not own lines.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::write(&repo, &at("intent.md"), &fix_intent("rejected"));
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 3: a difference of the final newline alone, on the first unaccepted document.
        let repo = fresh();
        commit_fix_drafts(&repo);
        testutil::write(&repo, &at("intent.md"), fix_intent("draft").trim_end());
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);

        // Row 3: the same on a later document.
        let repo = fresh();
        commit_fix_drafts(&repo);
        let plan = pinned_plan("draft", "pending acceptance");
        testutil::write(&repo, &at("plan.md"), plan.trim_end());
        assert_eq!(only_change(&repo).stage, Stage::FixInProgress);
    }

    #[test]
    fn fix_documents_checked_out_as_crlf_are_not_edits_f1() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        git::run(&repo, &["config", "core.autocrlf", "true"]).unwrap();
        let at = |file: &str| format!("{FIX_DIR}/{file}");
        let crlf = |text: String| text.replace('\n', "\r\n");
        testutil::commit_file(&repo, &at("intent.md"), &crlf(fix_intent("draft")), "draft");
        testutil::commit_file(
            &repo,
            &at("spec.md"),
            &crlf(pinned_spec("draft", "pending acceptance")),
            "draft",
        );
        testutil::commit_file(
            &repo,
            &at("plan.md"),
            &crlf(pinned_plan("draft", "pending acceptance")),
            "draft",
        );
        // Git stores LF and the working copies read CRLF, yet `git status` reports nothing.
        assert_eq!(git::run(&repo, &["status", "--porcelain"]).unwrap(), "");
        let working = std::fs::read(repo.join(at("intent.md"))).unwrap();
        assert!(working.windows(2).any(|w| w == b"\r\n"));
        assert_eq!(only_change(&repo).stage, Stage::FixAwaiting);
    }

    #[test]
    fn a_fix_the_program_cannot_read_is_unsettled_with_its_message_f3() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        commit_fix_drafts(&repo);
        let got = list(None, &repo, "claims");
        assert_eq!(got[0].stage, Stage::FixUnsettled);
        assert_eq!(got[0].intent.head_status, None);
        assert!(got[0].plan_unreadable);
        assert!(got[0].plan_unreadable_reason.is_some());
    }

    #[test]
    fn a_full_pipeline_change_carries_no_head_status_f5() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(
            &repo,
            &format!("{FIX_DIR}/intent.md"),
            "---\nstatus: draft\n---\nintent\n",
            "draft",
        );
        let info = only_change(&repo);
        assert_eq!(info.track, Track::Full);
        assert_eq!(info.intent.head_status, None);
    }

    #[test]
    fn doc_state_reads_the_head_status() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let at = |file: &str| format!("{FIX_DIR}/{file}");
        testutil::commit_file(&repo, &at("intent.md"), &fix_intent("draft"), "draft");
        testutil::write(&repo, &at("intent.md"), &fix_intent("accepted"));
        testutil::write(
            &repo,
            &at("spec.md"),
            &pinned_spec("draft", "pending acceptance"),
        );
        let info = only_change(&repo);
        assert_eq!(info.intent.status.as_deref(), Some("accepted"));
        assert_eq!(info.intent.head_status.as_deref(), Some("draft"));
        assert_eq!(info.spec.status.as_deref(), Some("draft"));
        assert_eq!(info.spec.head_status, None);
        assert_eq!(info.plan.head_status, None);
    }

    /// A repo holding one committed `intent.md` per name, each on the track `track`.
    fn repo_of_intents(tmp: &Path, names: &[(&str, &str)]) -> std::path::PathBuf {
        let repo = testutil::repo(tmp, "m");
        for (name, track) in names {
            testutil::commit_file(
                &repo,
                &format!("intent/claims/{name}/intent.md"),
                &format!("---\nstatus: draft\ntrack: {track}\n---\nintent\n"),
                "intent",
            );
        }
        repo
    }
    fn calls(plugin: &Path) -> Vec<String> {
        std::fs::read_to_string(plugin.join("format").join("calls.log"))
            .map(|t| t.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }
    fn change_named<'a>(got: &'a [ChangeInfo], name: &str) -> &'a ChangeInfo {
        got.iter().find(|c| c.change == name).unwrap()
    }

    #[test]
    fn one_program_process_reads_every_fix_of_a_system_r4_1() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = testutil::fake_fix_plugin(&tmp.path().join("p"), "0.13.0");
        let repo = repo_of_intents(
            tmp.path(),
            &[
                ("2026-10-01-row6-a", "fix"),
                ("2026-10-02-row7-b", "fix"),
                ("2026-10-03-row6-c", "fix"),
                ("2026-10-04-full", "full"),
            ],
        );
        let got = list(Some(&plugin), &repo, "claims");
        assert_eq!(calls(&plugin), vec!["fix-state 3"]);
        let six = change_named(&got, "2026-10-01-row6-a");
        assert_eq!((six.stage, six.fix_row), (Stage::FixAwaiting, Some(6)));
        let seven = change_named(&got, "2026-10-02-row7-b");
        assert_eq!((seven.stage, seven.fix_row), (Stage::FixAwaiting, Some(7)));
        let full = change_named(&got, "2026-10-04-full");
        assert_eq!(full.fix_row, None);
    }

    #[test]
    fn an_older_plugin_reads_every_fix_as_needing_the_plugin_without_running_it_r10_1() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = testutil::fake_fix_plugin(&tmp.path().join("p"), "0.12.0");
        let repo = repo_of_intents(
            tmp.path(),
            &[("2026-10-01-row6-a", "fix"), ("2026-10-02-row7-b", "fix")],
        );
        let got = list(Some(&plugin), &repo, "claims");
        assert_eq!(got.len(), 2);
        for info in &got {
            assert_eq!(info.track, Track::Fix);
            assert_eq!(info.stage, Stage::FixNeedsPlugin);
            assert_eq!(info.fix_row, None);
            assert_eq!(
                info.plan_unreadable_reason.as_deref(),
                Some("Needs ai-sdlc 0.13.0 or later.")
            );
        }
        assert!(calls(&plugin).is_empty());
    }

    #[test]
    fn a_row_the_workbench_does_not_know_and_a_failed_folder_read_as_unsettled() {
        let tmp = tempfile::tempdir().unwrap();
        let plugin = testutil::fake_fix_plugin(&tmp.path().join("p"), "0.13.0");
        let repo = repo_of_intents(
            tmp.path(),
            &[
                ("2026-10-01-row9", "fix"),
                ("2026-10-02-broken", "fix"),
                ("2026-10-03-row6", "fix"),
            ],
        );
        let got = list(Some(&plugin), &repo, "claims");
        let nine = change_named(&got, "2026-10-01-row9");
        assert_eq!(nine.stage, Stage::FixUnsettled);
        assert_eq!(nine.fix_row, Some(9));
        assert!(nine.plan_unreadable);
        let broken = change_named(&got, "2026-10-02-broken");
        assert_eq!(broken.stage, Stage::FixUnsettled);
        assert_eq!(broken.fix_row, None);
        assert!(broken
            .plan_unreadable_reason
            .as_deref()
            .unwrap()
            .contains("git failed"));
        assert_eq!(
            change_named(&got, "2026-10-03-row6").stage,
            Stage::FixAwaiting
        );
    }

    #[test]
    fn fix_stage_drafts_outside_the_workbench_show_as_a_fix_r4_3() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        commit_fix_drafts(&repo);
        let info = only_change(&repo);
        assert_eq!(info.track, Track::Fix);
        assert_eq!(info.stage, Stage::FixAwaiting);
    }

    #[test]
    fn fix_stage_accepted_in_three_commits_is_ready_to_build_r4_2() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        commit_fix_drafts(&repo);
        accept_fix_in_steps(&repo, true, true, true);
        let info = only_change(&repo);
        assert_eq!(info.track, Track::Fix);
        assert_eq!(info.stage, Stage::BuildReady);
        assert_eq!(info.out_of_date, None);
    }

    #[test]
    fn full_pipeline_stages_are_unchanged_r13_1() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-full";
        let at = |file: &str| format!("{dir}/{file}");
        let stage = |repo: &Path| {
            let info = only_change(repo);
            assert_eq!(info.track, Track::Full);
            info.stage
        };
        testutil::commit_file(&repo, &at("intent.md"), "---\nstatus: draft\n---\ni\n", "i");
        assert_eq!(stage(&repo), Stage::IntentAwaiting);
        testutil::commit_file(
            &repo,
            &at("intent.md"),
            "---\nstatus: accepted\n---\ni\n",
            "i2",
        );
        assert_eq!(stage(&repo), Stage::SpecReady);
        let pin = last_commit_of(&repo, &at("intent.md"));
        testutil::commit_file(&repo, &at("spec.md"), &pinned_spec("draft", &pin), "s");
        assert_eq!(stage(&repo), Stage::SpecAwaiting);
        testutil::commit_file(&repo, &at("spec.md"), &pinned_spec("accepted", &pin), "s2");
        assert_eq!(stage(&repo), Stage::PlanReady);
        let pin = last_commit_of(&repo, &at("spec.md"));
        testutil::commit_file(&repo, &at("plan.md"), &pinned_plan("draft", &pin), "p");
        assert_eq!(stage(&repo), Stage::PlanAwaiting);
        testutil::commit_file(&repo, &at("plan.md"), &pinned_plan("accepted", &pin), "p2");
        assert_eq!(stage(&repo), Stage::BuildReady);
        testutil::commit_file(
            &repo,
            &at("build/app.md"),
            "# Build log: app\n\n| Task | Commits | Departure |\n|---|---|---|\n| T1 | `a111111` | none |\n",
            "log",
        );
        assert_eq!(stage(&repo), Stage::BuildFinished);
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

    /// The change list for an accepted plan with the extra front matter `front`, read by the real format program.
    fn reason_for_plan(front: &str) -> serde_json::Value {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        let spec_pin = accepted_spec(&repo, dir);
        let plan = format!(
            "---\nstatus: accepted\nsource_spec_commit: {spec_pin}\n{front}---\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
        );
        testutil::commit_file(&repo, &format!("{dir}/plan.md"), &plan, "plan");
        let got = list(Some(testutil::plugin_dir()), &repo, "claims");
        serde_json::to_value(&got[0]).unwrap()
    }

    #[test]
    fn an_unreadable_plan_carries_the_programs_message_for_a_layout_too_new_f26() {
        let json = reason_for_plan("layout: 3\n");
        assert_eq!(json["plan_unreadable"], serde_json::json!(true));
        let why = json["plan_unreadable_reason"].as_str().unwrap_or_default();
        assert!(why.contains("layout 3 is newer"), "got {why:?}");
    }

    #[test]
    fn an_unreadable_plan_carries_the_programs_message_for_a_broken_front_matter_f26() {
        let json = reason_for_plan("layout: soon\n");
        assert_eq!(json["plan_unreadable"], serde_json::json!(true));
        let why = json["plan_unreadable_reason"].as_str().unwrap_or_default();
        assert!(why.contains("layout must be a whole number"), "got {why:?}");
    }

    #[test]
    fn a_plan_without_a_usable_plugin_says_the_plugin_is_missing_f26() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let dir = "intent/claims/2026-10-12-fnol";
        let spec_pin = accepted_spec(&repo, dir);
        let plan = format!(
            "---\nstatus: accepted\nsource_spec_commit: {spec_pin}\n---\n\n## Tasks\n\n### T1: One (`app`)\n\n- **Depends on:** none\n"
        );
        testutil::commit_file(&repo, &format!("{dir}/plan.md"), &plan, "plan");
        let got = list(None, &repo, "claims");
        let json = serde_json::to_value(&got[0]).unwrap();
        let why = json["plan_unreadable_reason"].as_str().unwrap_or_default();
        assert!(why.contains("plugin"), "got {why:?}");
    }

    #[test]
    fn a_readable_plan_carries_no_reason_f26() {
        let json = reason_for_plan("layout: 2\n");
        assert_eq!(json["plan_unreadable"], serde_json::json!(false));
        assert_eq!(json["plan_unreadable_reason"], serde_json::Value::Null);
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

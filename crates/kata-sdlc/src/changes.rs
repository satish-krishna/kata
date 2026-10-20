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
    PlanWritten,
    PlanSuperseded,
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct BranchInfo {
    pub current: Option<String>,
    pub others: Vec<String>,
    pub default_base: Option<String>,
}

/// The spec's "Stage derivation and actions" table, rows in order.
pub fn derive_stage(intent: &DocState, spec: &DocState, plan: &DocState) -> Stage {
    if intent.is("rejected") {
        return Stage::Rejected;
    }
    if intent.is("accepted") && !intent.committed {
        return Stage::IntentAcceptedUncommitted;
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
    if !plan.exists {
        return Stage::PlanReady;
    }
    if plan.is("superseded") {
        Stage::PlanSuperseded
    } else {
        Stage::PlanWritten
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

/// The changes of `system` in the master repo, newest folder name first.
pub fn list(master: &Path, system: &str) -> Vec<ChangeInfo> {
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
            let stage = derive_stage(&intent, &spec, &plan);
            ChangeInfo {
                system: system.to_string(),
                change,
                intent,
                spec,
                plan,
                stage,
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

    #[test]
    fn derive_stage_table() {
        let d = derive_stage;
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
        assert_eq!(d(&acc, &spec, &doc(true, "draft")), Stage::PlanWritten);
        assert_eq!(
            d(&acc, &spec, &doc(true, "superseded")),
            Stage::PlanSuperseded
        );
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
        let got = list(&repo, "claims");
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
        let names: Vec<_> = list(&repo, "s").into_iter().map(|c| c.change).collect();
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
        let got = list(&repo, "s");
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
            assert!(list(&repo, bad).is_empty(), "{bad}");
        }
    }
}

//! Source pins: a spec or plan records the commit of the document above it that it was written
//! from, and the pin holds only while that document is unchanged since.
use crate::{frontmatter, git};
use std::path::Path;

/// The plugin's rule: true only when `pin` names a commit from which `upstream_rel` is
/// unchanged at `HEAD`. A missing or empty pin, one that could be read as a git option, an
/// unknown commit, and any git error are all false.
pub fn holds(repo: &git::Repo, pin: Option<&str>, upstream_rel: &str) -> bool {
    let Some(pin) = pin.filter(|p| !p.is_empty() && !p.starts_with('-')) else {
        return false;
    };
    if !repo.resolves_to_commit(pin) {
        return false;
    }
    // Both absent holds, as `git diff --quiet` decides; a changed file mode does not.
    match (
        repo.entry_at(pin, upstream_rel),
        repo.entry_at("HEAD", upstream_rel),
    ) {
        (Ok(then), Ok(now)) => then == now,
        _ => false,
    }
}

/// Whether the spec's `source_intent_commit` still matches `intent.md`.
pub fn spec_pin_holds(master: &Path, system: &str, change: &str) -> bool {
    pin_holds(
        master,
        system,
        change,
        "spec.md",
        "source_intent_commit",
        "intent.md",
    )
}

/// Whether the plan's `source_spec_commit` still matches `spec.md`.
pub fn plan_pin_holds(master: &Path, system: &str, change: &str) -> bool {
    pin_holds(
        master,
        system,
        change,
        "plan.md",
        "source_spec_commit",
        "spec.md",
    )
}

fn pin_holds(
    master: &Path,
    system: &str,
    change: &str,
    doc: &str,
    key: &str,
    upstream: &str,
) -> bool {
    let dir = master.join(format!("intent/{system}/{change}"));
    let pin = std::fs::read_to_string(dir.join(doc))
        .ok()
        .and_then(|t| frontmatter::field(&t, key));
    let Ok(repo) = git::Repo::open(master) else {
        return false;
    };
    holds(
        &repo,
        pin.as_deref(),
        &format!("intent/{system}/{change}/{upstream}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    const SYS: &str = "claims";
    const CHG: &str = "2026-10-12-fnol";
    const INTENT: &str = "intent/claims/2026-10-12-fnol/intent.md";
    const SPEC: &str = "intent/claims/2026-10-12-fnol/spec.md";

    fn open(repo: &Path) -> git::Repo {
        git::Repo::open(repo).unwrap()
    }

    fn head(repo: &Path) -> String {
        git::run(repo, &["rev-parse", "HEAD"]).unwrap()
    }

    fn spec_text(pin: &str) -> String {
        format!("---\nstatus: accepted\nsource_intent_commit: {pin}\n---\nbody\n")
    }

    /// A master repo with an intent, then a spec pinned to the intent's commit.
    fn pinned(tmp: &Path) -> (std::path::PathBuf, String) {
        let repo = testutil::repo(tmp, "master");
        testutil::commit_file(&repo, INTENT, "v1\n", "intent");
        let pin = head(&repo);
        testutil::commit_file(&repo, SPEC, &spec_text(&pin), "spec");
        (repo, pin)
    }

    #[test]
    fn pin_holds_when_upstream_is_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, pin) = pinned(tmp.path());
        assert!(holds(&open(&repo), Some(&pin), INTENT));
        assert!(spec_pin_holds(&repo, SYS, CHG));
    }

    #[test]
    fn pin_fails_after_upstream_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, pin) = pinned(tmp.path());
        testutil::commit_file(&repo, INTENT, "v2\n", "intent changed");
        assert!(!holds(&open(&repo), Some(&pin), INTENT));
        assert!(!spec_pin_holds(&repo, SYS, CHG));
    }

    #[test]
    fn pin_fails_when_missing_or_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, _) = pinned(tmp.path());
        assert!(!holds(&open(&repo), None, INTENT));
        assert!(!holds(&open(&repo), Some(""), INTENT));
        assert!(!holds(&open(&repo), Some("deadbeef"), INTENT));
        assert!(!holds(&open(&repo), Some("--output=x"), INTENT));
        assert!(!repo.join("x").exists());
        // A spec without the field, and a change with no spec at all.
        testutil::commit_file(&repo, SPEC, "---\nstatus: accepted\n---\n", "no pin");
        assert!(!spec_pin_holds(&repo, SYS, CHG));
        assert!(!plan_pin_holds(&repo, SYS, CHG));
    }

    #[test]
    fn pin_ignores_unrelated_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, pin) = pinned(tmp.path());
        testutil::commit_file(&repo, "intent/claims/other/intent.md", "z\n", "other");
        testutil::commit_file(
            &repo,
            "README.md",
            "changed
",
            "readme",
        );
        assert!(holds(&open(&repo), Some(&pin), INTENT));
        // The plan pin follows spec.md the same way.
        let spec_commit = head(&repo);
        testutil::commit_file(
            &repo,
            "intent/claims/2026-10-12-fnol/plan.md",
            &format!("---\nsource_spec_commit: {spec_commit}\n---\n"),
            "plan",
        );
        assert!(plan_pin_holds(&repo, SYS, CHG));
    }
}

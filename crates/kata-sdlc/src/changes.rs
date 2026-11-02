//! A change's documents read straight from the master's working tree, and the name checks that guard every
//! path built from a system or change name.
use crate::build::program;
use crate::format::{self, FormatError, ReadResult};
use std::path::Path;

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
    format::read_with(&program(plugin), &file, format::Reads::Shown).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    #[test]
    fn read_parsed_reads_a_spec_and_a_plan_and_refuses_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        let spec = include_str!("../tests/ai-sdlc-tools/examples/spec/2/valid.md");
        let plan = include_str!("../tests/ai-sdlc-tools/examples/plan/2/valid.md");
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
        }
    }
}

//! The builtin kit: the `kata` workflow plugin, embedded into the engine at
//! build time (see `build.rs`) so `[plugins.kata]` resolves in any workdir —
//! not just a checkout of this repo. The embedded tree is materialized on
//! demand under `<kata-home>/builtin/` into a content-addressed directory
//! (`kata-<hash>`), so upgraded binaries refresh automatically, repeat calls
//! are a cheap existence check, and concurrent processes never trample each
//! other (each writes a private temp dir and renames; first rename wins).

use std::path::PathBuf;

include!(concat!(env!("OUT_DIR"), "/builtin_kit.rs"));

/// The plugin name a run-spec uses to select the builtin kit: `[plugins.kata]`.
pub(crate) const BUILTIN_PLUGIN_NAME: &str = "kata";

/// FNV-1a over every embedded path and content, so the materialized dir name
/// changes exactly when the kit's content does.
fn stamp() -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for (rel, bytes) in FILES {
        mix(rel.as_bytes());
        mix(bytes);
    }
    format!("{h:016x}")
}

/// Ensure the embedded kit exists on disk and return its root. `None` when the
/// build embedded nothing (crate built outside a kata tree) or there is no
/// resolvable kata home.
pub(crate) fn ensure_materialized() -> Option<PathBuf> {
    if FILES.is_empty() {
        return None;
    }
    let base = crate::fsutil::kata_home()?.join("builtin");
    let dir = base.join(format!("{}-{}", BUILTIN_PLUGIN_NAME, stamp()));
    let marker = dir.join(".claude-plugin").join("plugin.json");
    if marker.is_file() {
        return Some(dir);
    }
    let tmp = base.join(format!(".tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    for (rel, bytes) in FILES {
        let dest = tmp.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        std::fs::write(&dest, bytes).ok()?;
    }
    match std::fs::rename(&tmp, &dir) {
        Ok(()) => Some(dir),
        // Lost the race to a concurrent materialization: theirs is identical
        // (content-addressed), so use it and drop ours.
        Err(_) if marker.is_file() => {
            let _ = std::fs::remove_dir_all(&tmp);
            Some(dir)
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&tmp);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn build_embedded_the_kit() {
        let has = |p: &str| FILES.iter().any(|(rel, _)| *rel == p);
        assert!(has(".claude-plugin/plugin.json"), "manifest embedded");
        for skill in ["prd", "context", "plan", "implement", "triage"] {
            assert!(has(&format!("skills/{skill}/SKILL.md")), "skill {skill}");
            assert!(has(&format!("commands/{skill}.md")), "command {skill}");
        }
        for agent in [
            "kata-scout",
            "kata-test-runner",
            "kata-implementer",
            "kata-reviewer",
        ] {
            assert!(has(&format!("agents/{agent}.md")), "agent {agent}");
        }
    }

    #[test]
    #[serial]
    fn materializes_once_and_reuses() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", home.path());

        let first = ensure_materialized().expect("materializes");
        assert!(first.join("skills").join("prd").join("SKILL.md").is_file());
        assert!(first.starts_with(home.path()), "lives under kata home");
        let stamp_before = std::fs::metadata(first.join(".claude-plugin").join("plugin.json"))
            .unwrap()
            .modified()
            .unwrap();

        let second = ensure_materialized().expect("still resolves");
        let stamp_after = std::fs::metadata(second.join(".claude-plugin").join("plugin.json"))
            .unwrap()
            .modified()
            .unwrap();

        std::env::remove_var("KATA_HOME");
        assert_eq!(first, second, "content-addressed path is stable");
        assert_eq!(stamp_before, stamp_after, "second call must not rewrite");
    }
}

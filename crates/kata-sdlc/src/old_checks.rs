//! The checks an engineer kept in the per-machine file before checks became the team's `build.finish` hooks.
//! Kata runs none of them and converts nothing: it reads the old file only to say what it held, tells the
//! engineer once, and remembers that it did in the settings.
use crate::store::Settings;
use serde::Serialize;
use std::path::Path;

/// What an old checks file held, for the notice.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OldChecks {
    /// Where the file is, as a display string.
    pub path: String,
    /// The file's text, verbatim.
    pub text: String,
}

/// The old checks file of `system` under `kata_home`, when it exists and the engineer has not been told about it yet.
pub fn notice(kata_home: &Path, system: &str, settings: &Settings) -> Option<OldChecks> {
    let _ = (kata_home, system, settings);
    None
}

/// `settings` with `system` recorded as told.
pub fn mark_shown(settings: &Settings, system: &str) -> Settings {
    let _ = system;
    settings.clone()
}

/// `incoming` with the systems already told about, as `stored` records them: a screen that saves its settings never
/// carries that list, and saving must not make a notice come back.
pub fn keep_shown(stored: &Settings, incoming: Settings) -> Settings {
    let _ = stored;
    incoming
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "[[check]]\nname = \"tests\"\ncommand = \"cargo test\"\n";

    fn home_with(system: &str, text: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("workbench").join("checks");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{system}.toml")), text).unwrap();
        home
    }

    fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            entries.sort();
            for p in entries {
                if p.is_dir() {
                    walk(&p, root, out);
                } else {
                    let rel = p
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push((rel, std::fs::read(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    /// R6.1: the engineer opens the system for the first time since the change and is shown what the file held.
    #[test]
    fn the_old_checks_file_is_shown_once() {
        let home = home_with("kata", OLD);
        let before = tree(home.path());

        let shown = notice(home.path(), "kata", &Settings::default()).expect("a notice");

        assert_eq!(shown.text, OLD);
        assert!(shown
            .path
            .replace('\\', "/")
            .ends_with("workbench/checks/kata.toml"));
        // Nothing is converted or committed: the machine holds the same files, byte for byte.
        assert_eq!(tree(home.path()), before);
    }

    /// R6.2: told once, never again, including after the settings are written to disk and read back.
    #[test]
    fn the_notice_is_not_repeated() {
        let home = home_with("kata", OLD);
        let told = mark_shown(&Settings::default(), "kata");
        assert_eq!(notice(home.path(), "kata", &told), None);

        let saved = serde_json::to_string(&told).unwrap();
        let reread: Settings = serde_json::from_str(&saved).unwrap();
        assert_eq!(notice(home.path(), "kata", &reread), None);

        // Telling the engineer about one system says nothing about another.
        std::fs::write(
            home.path()
                .join("workbench")
                .join("checks")
                .join("bob.toml"),
            OLD,
        )
        .unwrap();
        assert!(notice(home.path(), "bob", &reread).is_some());
        // Marking twice records the system once.
        assert_eq!(mark_shown(&told, "kata"), told);
    }

    #[test]
    fn no_file_no_notice() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(notice(home.path(), "kata", &Settings::default()), None);
        let other = home_with("bob", OLD);
        assert_eq!(notice(other.path(), "kata", &Settings::default()), None);
    }

    #[test]
    fn a_system_name_is_never_a_path() {
        let home = home_with("kata", OLD);
        for bad in ["", "..", "../checks/kata", "a/b", "a\\b"] {
            assert_eq!(
                notice(home.path(), bad, &Settings::default()),
                None,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn saving_the_settings_keeps_the_systems_already_told() {
        let stored = mark_shown(&Settings::default(), "kata");
        let from_screen = Settings {
            remember: true,
            ..Settings::default()
        };
        let kept = keep_shown(&stored, from_screen);
        assert!(kept.remember);
        assert_eq!(kept.old_checks_shown, vec!["kata".to_string()]);
    }
}

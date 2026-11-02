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

/// One system's old checks notice, in a list for several systems.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OldChecksNotice {
    pub system: String,
    /// Where the file is, as a display string.
    pub path: String,
    /// The file's text, verbatim.
    pub text: String,
}

/// The notices for `systems`, in the order given, each system once: those with an old checks file the engineer has
/// not been told about.
pub fn notices(kata_home: &Path, systems: &[String], settings: &Settings) -> Vec<OldChecksNotice> {
    let mut out: Vec<OldChecksNotice> = Vec::new();
    for system in systems {
        if out.iter().any(|n| &n.system == system) {
            continue;
        }
        if let Some(old) = notice(kata_home, system, settings) {
            out.push(OldChecksNotice {
                system: system.clone(),
                path: old.path,
                text: old.text,
            });
        }
    }
    out
}

/// `settings` with every one of `systems` recorded as told.
pub fn mark_all_shown(settings: &Settings, systems: &[String]) -> Settings {
    systems
        .iter()
        .fold(settings.clone(), |told, system| mark_shown(&told, system))
}

/// The old checks file of `system` under `kata_home`, when it exists and the engineer has not been told about it yet.
/// The file is read to be shown and nothing else: it is never parsed into anything that runs.
pub fn notice(kata_home: &Path, system: &str, settings: &Settings) -> Option<OldChecks> {
    if !is_name(system) || settings.old_checks_shown.iter().any(|s| s == system) {
        return None;
    }
    let path = kata_home
        .join("workbench")
        .join("checks")
        .join(format!("{system}.toml"));
    let text = std::fs::read_to_string(&path).ok()?;
    Some(OldChecks {
        path: path.to_string_lossy().into_owned(),
        text,
    })
}

/// A system name is a file stem, never a path.
fn is_name(system: &str) -> bool {
    !system.is_empty() && system != ".." && system != "." && !system.contains(['/', '\\', ':'])
}

/// `settings` with `system` recorded as told.
pub fn mark_shown(settings: &Settings, system: &str) -> Settings {
    let mut out = settings.clone();
    if !out.old_checks_shown.iter().any(|s| s == system) {
        out.old_checks_shown.push(system.to_string());
    }
    out
}

/// `incoming` with the systems already told about, as `stored` records them: a screen that saves its settings never
/// carries that list, and saving must not make a notice come back.
pub fn keep_shown(stored: &Settings, mut incoming: Settings) -> Settings {
    for system in &stored.old_checks_shown {
        if !incoming.old_checks_shown.contains(system) {
            incoming.old_checks_shown.push(system.clone());
        }
    }
    incoming
}

/// Record on this machine that the engineer has been told about the old checks files of `systems`.
pub fn record_shown(systems: &[String]) -> Result<(), crate::store::StoreError> {
    let settings = crate::store::load_settings();
    crate::store::save_settings(&mark_all_shown(&settings, systems))
}

/// Where the Kata home is: the parent of the `workbench` folder.
pub fn kata_home() -> Option<std::path::PathBuf> {
    crate::store::workbench_dir().and_then(|d| d.parent().map(Path::to_path_buf))
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

    /// R6.1 for a workspace of several systems: one answer for the set, each untold system once, in the order asked.
    #[test]
    fn the_notices_for_several_systems_come_in_one_answer() {
        let home = home_with("kata", OLD);
        let dir = home.path().join("workbench").join("checks");
        std::fs::write(dir.join("bob.toml"), "bob").unwrap();
        std::fs::write(dir.join("told.toml"), "told").unwrap();
        let settings = mark_shown(&Settings::default(), "told");
        let systems: Vec<String> = ["bob", "none", "told", "kata", "bob"]
            .map(String::from)
            .to_vec();

        let found = notices(home.path(), &systems, &settings);

        assert_eq!(
            found
                .iter()
                .map(|n| (n.system.as_str(), n.text.as_str()))
                .collect::<Vec<_>>(),
            vec![("bob", "bob"), ("kata", OLD)]
        );
        // Recording the set as told silences every one of them, each recorded once.
        let told = mark_all_shown(&settings, &systems[..]);
        assert!(notices(home.path(), &systems, &told).is_empty());
        assert_eq!(
            told.old_checks_shown,
            ["told", "bob", "none", "kata"].map(String::from).to_vec()
        );
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

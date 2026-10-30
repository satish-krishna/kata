//! A system's naming setting: the team's patterns for change branch names and pull request titles.
//!
//! The setting lives in the master repository's `.ai-sdlc.json`, under `systems.<system>.naming`, and is
//! read only from the commit at the base branch, so it is the same for every engineer and cannot be
//! changed on one machine. The ai-sdlc plugin's format program holds every rule about what a usable
//! setting is and how the patterns are filled; this module only asks it.
use crate::format::{self, NamingAnswer, NamingPatterns, NamingValues};
use crate::plugin::{Readiness, NAMING_VERSION};
use crate::workspace::MARKER;
use crate::{branch, build, decide, frontmatter, git};
use std::path::{Path, PathBuf};

/// The patterns of a usable naming setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Naming {
    pub branch: String,
    pub pull_request_title: String,
}

/// The names a change gets from the patterns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Names {
    pub branch: String,
    /// `None` when the intent names no title.
    pub pull_request_title: Option<String>,
}

/// Why a name or a setting cannot be used.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NamingError {
    #[error("the ai-sdlc plugin is not installed")]
    PluginMissing,
    #[error(
        "the system's naming setting needs ai-sdlc plugin {need} or later, this machine has {have}"
    )]
    PluginTooOld { have: String, need: String },
    #[error("the naming setting cannot be used: {}", .0.join("; "))]
    Unusable(Vec<String>),
    #[error("the naming setting cannot be read: {0}")]
    Unreadable(String),
    #[error("not a usable branch name: {0}")]
    Name(String),
}

/// The marker as committed at the master's base branch; `None` when there is no such commit or file.
fn committed_marker(master: &Path) -> Option<Vec<u8>> {
    let base = branch::default_base(master)?;
    git::Repo::open(master)
        .ok()?
        .bytes_at(&base, MARKER)
        .ok()
        .flatten()
}

/// Whether the shared settings declare a naming setting for `system`. False only when the marker at the
/// master's base branch parses and the system has no `naming` key; a marker that cannot be read counts as
/// declared, so a broken marker never falls back to `change/` naming.
pub fn declared(master: &Path, system: &str) -> bool {
    let Some(marker) = committed_marker(master)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return true;
    };
    match marker.get("systems") {
        Some(serde_json::Value::Object(systems)) => match systems.get(system) {
            Some(serde_json::Value::Object(entry)) => entry.contains_key("naming"),
            Some(_) => true,
            None => false,
        },
        _ => true,
    }
}

/// The plugin folder, when it can run the naming commands.
fn naming_program(plugin: &Readiness) -> Result<PathBuf, NamingError> {
    match plugin {
        Readiness::Missing => Err(NamingError::PluginMissing),
        Readiness::TooOld { have, .. } => Err(NamingError::PluginTooOld {
            have: have.clone(),
            need: NAMING_VERSION.to_string(),
        }),
        Readiness::Ready {
            version,
            naming: false,
            ..
        } => Err(NamingError::PluginTooOld {
            have: version.clone(),
            need: NAMING_VERSION.to_string(),
        }),
        Readiness::Ready { dir, .. } => Ok(build::program(dir)),
    }
}

/// Asks the program about `system`'s setting in the base branch's marker. `Ok(None)` when not declared.
fn read(
    plugin: &Readiness,
    master: &Path,
    system: &str,
    values: Option<&NamingValues>,
) -> Result<Option<NamingAnswer>, NamingError> {
    if !declared(master, system) {
        return Ok(None);
    }
    let program = naming_program(plugin)?;
    let bytes = committed_marker(master).ok_or_else(|| {
        NamingError::Unreadable(format!("{MARKER} is not committed at the base branch"))
    })?;
    // The program reads a file, so the committed bytes are staged beside the other committed documents.
    let stage = build::staging_dir(master, system, "naming");
    let lock = build::reading(&stage);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let file = stage.join(MARKER);
    std::fs::create_dir_all(&stage)
        .and_then(|_| std::fs::write(&file, &bytes))
        .map_err(|e| NamingError::Unreadable(format!("{}: {e}", file.display())))?;
    let answer = format::naming_read(&program, &file, system, values)
        .map_err(|e| NamingError::Unreadable(e.to_string()))?;
    if !answer.problems.is_empty() {
        return Err(NamingError::Unusable(answer.problems));
    }
    Ok(Some(answer))
}

/// The system's naming setting. `Ok(None)` when none is declared.
pub fn setting(
    plugin: &Readiness,
    master: &Path,
    system: &str,
) -> Result<Option<Naming>, NamingError> {
    let Some(answer) = read(plugin, master, system, None)? else {
        return Ok(None);
    };
    match answer.setting {
        Some(NamingPatterns {
            branch: Some(branch),
            pull_request_title: Some(pull_request_title),
        }) => Ok(Some(Naming {
            branch,
            pull_request_title,
        })),
        _ => Err(NamingError::Unreadable(
            "the program found no patterns in a setting without problems".into(),
        )),
    }
}

/// The branch name and pull request title the setting gives `change`. `Ok(None)` when none is declared.
pub fn names(
    plugin: &Readiness,
    master: &Path,
    system: &str,
    change: &str,
    work_type: &str,
) -> Result<Option<Names>, NamingError> {
    let title = std::fs::read_to_string(master.join(format!("intent/{system}/{change}/intent.md")))
        .ok()
        .and_then(|t| frontmatter::field(&t, "title"))
        .filter(|t| !t.is_empty());
    let values = NamingValues {
        work_type: work_type.to_string(),
        scope: decide::change_scope(master, system, change),
        change: change.to_string(),
        title,
    };
    let Some(answer) = read(plugin, master, system, Some(&values))? else {
        return Ok(None);
    };
    answer
        .names
        .map(|n| {
            Some(Names {
                branch: n.branch,
                pull_request_title: n.pull_request_title,
            })
        })
        .ok_or_else(|| NamingError::Unreadable("the program rendered no names".into()))
}

/// Refuses a branch name git or Kata would not accept. Called before any branch is created or renamed
/// from a name Kata did not build itself.
pub fn check_branch_name(plugin: &Readiness, name: &str) -> Result<(), NamingError> {
    let program = naming_program(plugin)?;
    let problems =
        format::branch_name(&program, name).map_err(|e| NamingError::Unreadable(e.to_string()))?;
    if problems.is_empty() {
        Ok(())
    } else {
        Err(NamingError::Name(problems.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{plugin, testutil};

    const SETTING: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"],"naming":{"branch":"{type}/{scope}-{slug}","pullRequestTitle":"{type}({scope}): {title}"}}}}"#;
    const NO_NAMING: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#;

    fn ready(version: &str) -> Readiness {
        Readiness::Ready {
            dir: testutil::plugin_dir().to_path_buf(),
            version: version.to_string(),
            layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            light_track: true,
            naming: plugin::naming(version),
        }
    }

    fn current() -> Readiness {
        ready(plugin::NAMING_VERSION)
    }

    fn master_with(marker: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        testutil::commit_file(&repo, ".ai-sdlc.json", marker, "marker");
        (tmp, repo)
    }

    fn the_patterns() -> Naming {
        Naming {
            branch: "{type}/{scope}-{slug}".into(),
            pull_request_title: "{type}({scope}): {title}".into(),
        }
    }

    #[test]
    fn setting_is_read_from_the_base_branch_commit_r1_1() {
        let (_tmp, repo) = master_with(SETTING);
        testutil::checkout(&repo, "elsewhere", true);
        assert!(declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(Some(the_patterns())));
    }

    #[test]
    fn setting_ignores_working_tree_and_change_branch_edits_r1_2() {
        let (_tmp, repo) = master_with(SETTING);
        testutil::write(&repo, ".ai-sdlc.json", NO_NAMING);
        assert!(declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(Some(the_patterns())));

        testutil::checkout(&repo, "change/2026-11-02-x", true);
        testutil::commit_file(&repo, ".ai-sdlc.json", NO_NAMING, "drop naming");
        assert!(declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(Some(the_patterns())));
    }

    #[test]
    fn broken_or_unreadable_setting_is_an_error_not_a_fallback_r3_2() {
        let bad_branch = r#"{"version":1,"systems":{"kata":{"naming":{"branch":"{type}/{ticket}-{slug}","pullRequestTitle":"{title}"}}}}"#;
        // marker, plugin version, declared, what `setting` gives
        let rows: [(&str, &str, bool, &str); 4] = [
            (NO_NAMING, "0.14.0", false, "none"),
            (bad_branch, "0.14.0", true, "unusable"),
            ("this is not json", "0.14.0", true, "unreadable"),
            (SETTING, "0.13.3", true, "too old"),
        ];
        for (marker, version, is_declared, expect) in rows {
            let (_tmp, repo) = master_with(marker);
            assert_eq!(declared(&repo, "kata"), is_declared, "{expect}");
            let got = setting(&ready(version), &repo, "kata");
            match (expect, got) {
                ("none", Ok(None)) => {}
                ("unusable", Err(NamingError::Unusable(problems))) => {
                    assert!(
                        problems.iter().any(|p| p.contains("ticket")),
                        "{problems:?}"
                    )
                }
                ("unreadable", Err(NamingError::Unreadable(_))) => {}
                ("too old", Err(NamingError::PluginTooOld { .. })) => {}
                (_, got) => panic!("{expect}: got {got:?}"),
            }
        }
    }

    #[test]
    fn setting_with_an_option_like_pattern_is_refused_r12_1() {
        let marker = r#"{"version":1,"systems":{"kata":{"naming":{"branch":"-f/{slug}","pullRequestTitle":"{title}"}}}}"#;
        let (_tmp, repo) = master_with(marker);
        assert!(matches!(
            setting(&current(), &repo, "kata"),
            Err(NamingError::Unusable(_))
        ));
    }

    #[test]
    fn names_fill_the_patterns_for_a_change() {
        let (_tmp, repo) = master_with(SETTING);
        testutil::commit_file(
            &repo,
            "intent/kata/2026-11-02-reset/intent.md",
            "---\nstatus: draft\nscope: PROJ-123\ntitle: Customer can reset password\n---\n",
            "intent",
        );
        assert_eq!(
            names(&current(), &repo, "kata", "2026-11-02-reset", "feat"),
            Ok(Some(Names {
                branch: "feat/PROJ-123-reset".into(),
                pull_request_title: Some("feat(PROJ-123): Customer can reset password".into()),
            }))
        );
    }

    #[test]
    fn a_name_that_git_or_kata_would_refuse_is_refused_r12_1() {
        for name in ["-D", "feat/../main", "feat/@{1}", "change/pending-x"] {
            assert!(
                matches!(
                    check_branch_name(&current(), name),
                    Err(NamingError::Name(_))
                ),
                "{name}"
            );
        }
        assert_eq!(check_branch_name(&current(), "feat/PROJ-123-reset"), Ok(()));
    }
}

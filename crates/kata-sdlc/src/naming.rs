//! A system's naming setting: the team's patterns for change branch names and pull request titles.
//!
//! The setting lives in the master repository's `.ai-sdlc.json`, under `systems.<system>.naming`, and is
//! read only from the commit at the base branch, so it is the same for every engineer and cannot be
//! changed on one machine. The ai-sdlc plugin's format program holds every rule about what a usable
//! setting is and how the patterns are filled; this module only asks it.
use crate::format::{self, NamingAnswer, NamingPatterns, NamingValues};
use crate::plugin::{BlockReason, Readiness, MIN_VERSION};
use crate::workspace::{Marker, MARKER};
use crate::{base, build, frontmatter, git};
use std::path::{Path, PathBuf};

/// Lowercase kebab-case, the only scope shape a commitlint header accepts.
fn is_scope(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// What a commit header's scope group takes: non-empty, no whitespace, no parentheses. Capitals stay, so
/// a ticket ID such as `PROJ-123` can be a scope.
fn fits_header(s: &str) -> bool {
    !s.is_empty() && !s.contains(|c: char| c.is_whitespace() || c == '(' || c == ')')
}

/// The scope a change starts with when its intent names none, as the ai-sdlc plugin resolves it: the intent's
/// `scope`, then the marker's `systems.<system>.commitScope`, then the system name. A malformed value is
/// skipped: the intent's must fit a commit header's scope group, the marker's must be lowercase kebab-case.
pub fn change_scope(master: &Path, system: &str, change: &str) -> String {
    let intent =
        std::fs::read_to_string(master.join(format!("intent/{system}/{change}/intent.md")))
            .ok()
            .and_then(|t| frontmatter::field(&t, "scope"));
    let marker = std::fs::read_to_string(master.join(MARKER))
        .ok()
        .and_then(|t| serde_json::from_str::<Marker>(&t).ok())
        .and_then(|m| m.systems.get(system)?.commit_scope.clone());
    intent
        .filter(|s| fits_header(s))
        .or_else(|| marker.filter(|s| is_scope(s)))
        .unwrap_or_else(|| system.to_string())
}

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
///
/// The base is the ai-sdlc skills' default branch: `origin/HEAD`'s target, else `main`, else `master`
/// (`base::base_branch`). It is never the current branch, so an edit on a pending or change branch cannot
/// change the setting. A local branch is read when it exists, else its `origin/` copy.
fn committed_marker(master: &Path) -> Option<Vec<u8>> {
    let base = base::base_branch(master)?;
    let repo = git::Repo::open(master).ok()?;
    let local = format!("refs/heads/{base}");
    let rev = if repo.rev_exists(&local) {
        local
    } else {
        format!("refs/remotes/origin/{base}")
    };
    repo.bytes_at(&rev, MARKER).ok().flatten()
}

/// Whether the shared settings declare a naming setting for `system`. False when no base branch resolves
/// or the base holds no `.ai-sdlc.json` (no setting is shared yet, so today's `change/<change>` naming
/// applies), and when the marker parses and the system has no `naming` key. A marker that is at the base
/// but cannot be parsed, or whose `systems` or system entry has the wrong shape, counts as declared, so a
/// broken marker never falls back to `change/` naming.
pub fn declared(master: &Path, system: &str) -> bool {
    let Some(bytes) = committed_marker(master) else {
        return false;
    };
    let Ok(marker) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
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
        Readiness::Blocked {
            reason: BlockReason::PluginTooOld,
            ..
        } => Err(NamingError::PluginTooOld {
            have: "an older version".to_string(),
            need: MIN_VERSION.to_string(),
        }),
        Readiness::Blocked { .. } => Err(NamingError::PluginMissing),
        Readiness::Ready { plugin, .. } => Ok(build::program(&plugin.dir)),
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
        scope: change_scope(master, system, change),
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

/// The name of a new change: `date` (`YYYY-MM-DD`) and the title's first words, at most five, in lowercase
/// kebab-case. Only ASCII letters and digits are kept; a title with no usable word gives `change`.
pub fn change_name(date: &str, title: &str) -> String {
    let words: Vec<String> = title
        .split(|c: char| c.is_whitespace() || matches!(c, '-' | '_' | '/'))
        .map(|w| {
            w.chars()
                .filter(char::is_ascii_alphanumeric)
                .collect::<String>()
                .to_ascii_lowercase()
        })
        .filter(|w| !w.is_empty())
        .take(5)
        .collect();
    if words.is_empty() {
        format!("{date}-change")
    } else {
        format!("{date}-{}", words.join("-"))
    }
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

/// Why `scope` cannot be used as a change's scope; empty when it is accepted as typed.
pub fn check_scope(plugin: &Readiness, scope: &str) -> Result<Vec<String>, NamingError> {
    let program = naming_program(plugin)?;
    format::scope(&program, scope).map_err(|e| NamingError::Unreadable(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{plugin, testutil};

    #[test]
    fn change_scope_reads_the_intent_then_the_marker_then_the_system() {
        const INTENT: &str = "intent/claims/2026-10-12-fnol/intent.md";
        const CHANGE: &str = "2026-10-12-fnol";
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        // No marker and no intent: the system.
        assert_eq!(change_scope(&repo, "claims", CHANGE), "claims");
        testutil::commit_file(
            &repo,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"claims":{"commitScope":"claims-sys"}}}"#,
            "marker",
        );
        assert_eq!(change_scope(&repo, "claims", CHANGE), "claims-sys");
        // The intent's scope wins when it fits a header; a malformed one is skipped; capitals stay.
        for (scope, expect) in [
            ("fnol", "fnol"),
            ("PROJ-123", "PROJ-123"),
            ("proj 123", "claims-sys"),
            ("a(b)", "claims-sys"),
        ] {
            testutil::commit_file(
                &repo,
                INTENT,
                &format!("---\nstatus: draft\nscope: \"{scope}\"\n---\n"),
                "i",
            );
            assert_eq!(change_scope(&repo, "claims", CHANGE), expect, "{scope}");
        }
        // A marker scope that is not lowercase kebab-case is skipped too.
        testutil::commit_file(
            &repo,
            ".ai-sdlc.json",
            r#"{"version":1,"systems":{"claims":{"commitScope":"Claims Sys"}}}"#,
            "marker",
        );
        testutil::commit_file(&repo, INTENT, "---\nstatus: draft\n---\n", "i");
        assert_eq!(change_scope(&repo, "claims", CHANGE), "claims");
    }

    const SETTING: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"],"naming":{"branch":"{type}/{scope}-{slug}","pullRequestTitle":"{type}({scope}): {title}"}}}}"#;
    const NO_NAMING: &str = r#"{"version":1,"systems":{"kata":{"repos":["kata"]}}}"#;

    fn ready(version: &str) -> Readiness {
        if !plugin::at_least(version, plugin::MIN_VERSION) {
            return Readiness::Blocked {
                reason: BlockReason::PluginTooOld,
                message: String::new(),
            };
        }
        Readiness::Ready {
            plugin: crate::plugin::Plugin {
                dir: testutil::plugin_dir().to_path_buf(),
                version: version.to_string(),
                layouts: crate::format::ACCEPTED_LAYOUTS.to_vec(),
            },
            gh: crate::plugin::GhPresence::Present,
        }
    }

    fn current() -> Readiness {
        ready(plugin::MIN_VERSION)
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
            (NO_NAMING, "1.1.0", false, "none"),
            (bad_branch, "1.1.0", true, "unusable"),
            ("this is not json", "1.1.0", true, "unreadable"),
            (SETTING, "1.0.0", true, "too old"),
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
    fn origin_head_target_wins_over_a_stale_main_r1_2() {
        let (_tmp, repo) = master_with(NO_NAMING);
        testutil::checkout(&repo, "develop", true);
        testutil::commit_file(&repo, ".ai-sdlc.json", SETTING, "setting");
        testutil::checkout(&repo, "main", false);
        git::run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
        )
        .unwrap();
        assert!(declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(Some(the_patterns())));
    }

    #[test]
    fn the_current_branch_is_never_the_base_for_the_setting_r1_2() {
        let (_tmp, repo) = master_with(NO_NAMING);
        git::run(&repo, &["branch", "-m", "main", "trunk"]).unwrap();
        testutil::checkout(&repo, "change/2026-11-02-x", true);
        testutil::commit_file(&repo, ".ai-sdlc.json", SETTING, "add naming");
        assert!(!declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(None));
    }

    #[test]
    fn no_marker_at_the_base_means_no_setting_yet_r2_1() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = testutil::repo(tmp.path(), "m");
        assert!(!declared(&repo, "kata"));
        assert_eq!(setting(&current(), &repo, "kata"), Ok(None));
    }

    #[test]
    fn a_marker_at_the_base_that_is_broken_stays_declared_r3_2() {
        for marker in [
            "this is not json",
            r#"{"version":1}"#,
            r#"{"version":1,"systems":{"kata":"x"}}"#,
        ] {
            let (_tmp, repo) = master_with(marker);
            assert!(declared(&repo, "kata"), "{marker}");
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

    #[test]
    fn a_scope_is_accepted_or_refused_with_the_reason_r5_2() {
        for scope in ["PROJ-123", "proj_123", "v2.1", "kata"] {
            assert_eq!(check_scope(&current(), scope), Ok(Vec::new()), "{scope}");
        }
        for (scope, reason) in [
            ("PROJ 123", "space"),
            ("-PROJ", "start"),
            ("PROJ(1)", "parentheses"),
            ("PROJ/123", "letters, digits"),
            ("PROJ..123", ".."),
        ] {
            let problems = check_scope(&current(), scope).unwrap();
            assert!(
                problems.iter().any(|p| p.contains(reason)),
                "{scope}: {problems:?}"
            );
        }
    }

    #[test]
    fn change_name_rows() {
        let rows = [
            ("two words", "Password reset", "2026-11-01-password-reset"),
            (
                "six words are cut to five",
                "Let customers reset their own password",
                "2026-11-01-let-customers-reset-their-own",
            ),
            (
                "punctuation is dropped",
                "Don't flag prices, please!",
                "2026-11-01-dont-flag-prices-please",
            ),
            ("one word", "Photos", "2026-11-01-photos"),
            (
                "hyphens and capitals",
                "Add Login-Page (v2)",
                "2026-11-01-add-login-page-v2",
            ),
            ("no usable word", "!!! ... ???", "2026-11-01-change"),
            ("an empty title", "   ", "2026-11-01-change"),
            (
                "letters outside ASCII are dropped",
                "café 日本",
                "2026-11-01-caf",
            ),
        ];
        for (label, title, want) in rows {
            assert_eq!(change_name("2026-11-01", title), want, "{label}");
        }
    }

    #[test]
    fn head_is_refused_as_a_branch_name_r12_1() {
        assert!(matches!(
            check_branch_name(&current(), "HEAD"),
            Err(NamingError::Name(_))
        ));
    }

    #[test]
    fn a_scope_git_would_refuse_in_a_branch_is_refused_r5_2() {
        for scope in ["HEAD", "v2.", "a.lock"] {
            let problems = check_scope(&current(), scope).unwrap();
            assert!(!problems.is_empty(), "{scope} was accepted");
        }
    }

    #[test]
    fn a_scope_cannot_be_checked_without_a_plugin_that_can_name_branches() {
        assert_eq!(
            check_scope(&Readiness::missing(), "kata"),
            Err(NamingError::PluginMissing)
        );
    }
}

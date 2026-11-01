//! The run-spec of a run of a change.

use crate::permissions::{rules, slashes, Rules, RunKind, RunPlace};
use kata_core::spec::{
    Auth, Given, Interactive, Leash, PermissionMode, Permissions, PluginConfig, UnmatchedPolicy,
};
use kata_core::RunSpec;
use std::collections::BTreeMap;
use std::path::Path;

/// What the engineer chose for this run.
#[derive(Clone, Debug)]
pub struct RunForm {
    /// The run's name and task; a build or review run composes its own.
    pub name: String,
    pub task: String,
    /// The empty-room setting; a run of a change ignores it (R5.4).
    pub bare: bool,
    /// The app's permission setting, for a document run.
    pub permission_mode: PermissionMode,
    pub timeout_secs: u64,
    pub instructions: Option<String>,
    pub continue_on_leftovers: bool,
}

const AI_SDLC: &str = "ai-sdlc";
const GITHUB_TOKENS: [&str; 3] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

/// The run-spec of a run of a change. It is never bare (R5.4): the empty room would drop the plugin's
/// gate and guard. A build or review run is always auto, since bypass forbids the deny rules that keep an
/// agent from publishing; it has no turn cap and no budget, and the time limit is per run. A repository's
/// run works in the engineer's checkout of it (the master repository's own run, and the review, work in
/// the change's master) and carries `--master <the change's master>`. A triage or fix run is held to the
/// change's documents the same way. A document run follows the form's permission mode, and a bypass one
/// keeps bypass and gets no rules: the posture is never switched here.
pub fn change_spec(place: &RunPlace, form: RunForm) -> RunSpec {
    let master = slashes(&place.master_path());
    let workspace = slashes(&place.workspace);
    let (name, task, workdir) = match &place.kind {
        RunKind::Build { .. } | RunKind::Review => {
            let (flag, name, workdir) = match &place.kind {
                RunKind::Build { repo } => (
                    format!("--repo {repo}"),
                    format!("sdlc-{}-{}-build-{repo}", place.system, place.state.change),
                    if *repo == place.master_name() {
                        master.clone()
                    } else {
                        format!("{workspace}/{repo}")
                    },
                ),
                _ => (
                    "--review".to_string(),
                    format!("sdlc-{}-{}-review", place.system, place.state.change),
                    master.clone(),
                ),
            };
            let mut task = format!(
                "Use the ai-sdlc build skill for system {} on change folder {} with {flag} --master {master}.",
                place.system, place.state.change
            );
            if form.continue_on_leftovers {
                task.push_str(" The engineer has already confirmed continuing on top of the uncommitted edits the previous run left; do not ask again.");
            }
            let instructions = form.instructions.as_deref().unwrap_or("").trim();
            if matches!(place.kind, RunKind::Build { .. }) && !instructions.is_empty() {
                task.push_str(&format!(
                    "\n\nInstructions from the engineer for this run:\n{instructions}"
                ));
            }
            (name, task, workdir)
        }
        _ => (
            form.name.clone(),
            form.task.clone(),
            slashes(Path::new(&place.state.folder)),
        ),
    };
    let held = !matches!(place.kind, RunKind::Document);
    let mode = if held {
        PermissionMode::Auto
    } else {
        form.permission_mode
    };
    let mut permissions = Permissions {
        mode,
        allow: Vec::new(),
        deny: Vec::new(),
        ask: Vec::new(),
        unmatched: UnmatchedPolicy::Ask,
    };
    if mode != PermissionMode::Bypass {
        let Rules { deny, allow } = rules(place);
        permissions.deny = deny;
        permissions.allow = allow;
    }
    let build = matches!(place.kind, RunKind::Build { .. } | RunKind::Review);
    RunSpec {
        name,
        task,
        workdir,
        plugins: BTreeMap::from([(AI_SDLC.to_string(), PluginConfig::default())]),
        given: Some(Given {
            required_plugins: vec![AI_SDLC.to_string()],
            build,
            ..Given::default()
        }),
        auth: Auth {
            bare: false,
            token_env: None,
        },
        interactive: Interactive {
            enabled: mode != PermissionMode::Bypass,
            answer_timeout_secs: Some(3600),
        },
        leash: Leash {
            timeout_secs: Some(form.timeout_secs),
            ..Leash::default()
        },
        env_remove: if held {
            GITHUB_TOKENS.iter().map(|s| s.to_string()).collect()
        } else {
            Vec::new()
        },
        permissions,
        ..RunSpec::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::fixtures::*;
    use crate::permissions::RunKind;

    fn form(bare: bool) -> RunForm {
        RunForm {
            name: "sdlc-commerce-2026-10-12-photos-spec".into(),
            task: "Use the ai-sdlc spec skill.".into(),
            bare,
            permission_mode: PermissionMode::Auto,
            timeout_secs: 7200,
            instructions: None,
            continue_on_leftovers: false,
        }
    }

    #[test]
    fn a_change_run_is_never_bare() {
        for kind in [
            RunKind::Document,
            RunKind::Triage,
            RunKind::Fix,
            RunKind::Build { repo: "app".into() },
            RunKind::Review,
        ] {
            let s = change_spec(&place_in_copies(kind.clone()), form(true));
            assert!(!s.auth.bare, "{kind:?}");
        }
    }

    #[test]
    fn a_build_run_carries_the_changes_master() {
        let p = place_in_copies(RunKind::Build { repo: "app".into() });
        let s = change_spec(&p, form(false));
        assert_eq!(
            s.task,
            format!("Use the ai-sdlc build skill for system commerce on change folder 2026-10-12-photos with --repo app --master {COPY_A}.")
        );
        assert_eq!(s.workdir, "/home/u/ws/app");
        assert_eq!(s.name, "sdlc-commerce-2026-10-12-photos-build-app");
        assert_eq!(s.leash.timeout_secs, Some(7200));
        assert_eq!(s.permissions.mode, PermissionMode::Auto);

        let r = change_spec(&place_in_copies(RunKind::Review), form(false));
        assert!(r
            .task
            .ends_with(&format!("with --review --master {COPY_A}.")));
        assert_eq!(r.workdir, COPY_A);
        assert_eq!(r.name, "sdlc-commerce-2026-10-12-photos-review");
    }

    #[test]
    fn a_bypass_document_run_keeps_bypass_and_gets_no_rules() {
        let mut f = form(false);
        f.permission_mode = PermissionMode::Bypass;
        let s = change_spec(&place_in_copies(RunKind::Document), f);
        assert_eq!(s.permissions.mode, PermissionMode::Bypass);
        assert!(s.permissions.deny.is_empty() && s.permissions.allow.is_empty());
    }
}

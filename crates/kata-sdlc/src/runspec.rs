//! The run-spec of a run of a change.

use crate::permissions::{rules, slashes, Rules, RunKind, RunPlace};
use kata_core::spec::{
    Auth, Given, Interactive, Leash, PermissionMode, Permissions, PluginConfig, UnmatchedPolicy,
};
use kata_core::RunSpec;
use std::collections::BTreeMap;
use std::path::Path;

/// What the engineer chose for this run.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct RunForm {
    /// The run's name and task; a build or review run composes its own.
    pub name: String,
    pub task: String,
    /// The empty-room setting; a run of a change ignores it (R5.4).
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<bool>"))]
    pub bare: bool,
    /// The app's permission setting, for a document run.
    pub permission_mode: PermissionMode,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub timeout_secs: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub instructions: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<bool>"))]
    pub continue_on_leftovers: bool,
    /// The items of a document run the engineer switched off in the preview; the plugins a run cannot do
    /// without and the build flag are the run kind's own and are set over it.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub given: Option<Given>,
}

/// How a switched-off choice is keyed across runs: a project item is qualified by the folder it came from, a
/// shared one is its own identity. The same key the Workbench's given rows carry.
pub fn given_key(id: &str, workdir: &str) -> String {
    let source = id.split(':').next().unwrap_or_default();
    if source != "project" && source != "project-local" {
        return id.to_string();
    }
    let mut dir = workdir.replace('\\', "/");
    while dir.ends_with('/') {
        dir.pop();
    }
    let bytes = dir.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        dir = format!("{}{}", dir[..1].to_ascii_lowercase(), &dir[1..]);
    }
    format!("{dir}|{id}")
}

/// The run-spec's given section for the run in `workdir` from the build's switched-off keys: a shared key
/// applies to every run, a project key only to the run in the folder it was qualified with.
pub fn given_for(off: &[String], workdir: &str) -> Given {
    let mut given = Given::default();
    for key in off {
        let id = match key.split_once('|') {
            Some((_, rest))
                if rest.starts_with("project:") || rest.starts_with("project-local:") =>
            {
                rest
            }
            _ => key.as_str(),
        };
        if given_key(id, workdir) != *key {
            continue;
        }
        let list = match id.split(':').nth(1) {
            Some("hook") => &mut given.hooks,
            Some("skill") => &mut given.skills,
            Some("plugin") => &mut given.plugins,
            Some("instruction") => &mut given.instructions,
            Some("tool-server") => &mut given.tool_servers,
            _ => continue,
        };
        list.push(id.to_string());
    }
    for list in [
        &mut given.hooks,
        &mut given.skills,
        &mut given.plugins,
        &mut given.instructions,
        &mut given.tool_servers,
    ] {
        list.sort();
        list.dedup();
    }
    given
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
            ..form.given.clone().unwrap_or_default()
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
            given: None,
        }
    }

    #[test]
    fn the_builds_choices_reach_a_run_as_its_given_section() {
        let off: Vec<String> = [
            "personal:tool-server:github",
            "d:/ws/commerce-core|project:tool-server:commerce-core-db",
            "d:/ws/customer-portal|project:tool-server:customer-portal-db",
            "personal:plugin:superpowers@claude-plugins-official",
            "run-spec:skill:doc-writer",
            "personal:instruction:CLAUDE.md",
        ]
        .map(String::from)
        .to_vec();
        let given = given_for(&off, "D:\\ws\\commerce-core\\");
        assert_eq!(given.skills, vec!["run-spec:skill:doc-writer"]);
        assert_eq!(
            given.plugins,
            vec!["personal:plugin:superpowers@claude-plugins-official"]
        );
        assert_eq!(given.instructions, vec!["personal:instruction:CLAUDE.md"]);
        assert_eq!(
            given.tool_servers,
            vec![
                "personal:tool-server:github",
                "project:tool-server:commerce-core-db"
            ]
        );
        assert!(given.hooks.is_empty());
        assert_eq!(given_for(&[], "D:/ws/commerce-core"), Given::default());
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

    #[test]
    fn a_document_run_keeps_the_items_the_engineer_switched_off() {
        let mut f = form(false);
        f.given = Some(Given {
            skills: vec!["brainstorming".into()],
            required_plugins: vec!["other".into()],
            build: true,
            ..Given::default()
        });
        let s = change_spec(&place_in_copies(RunKind::Document), f);
        let given = s.given.unwrap();
        assert_eq!(given.skills, vec!["brainstorming".to_string()]);
        assert_eq!(given.required_plugins, vec!["ai-sdlc".to_string()]);
        assert!(!given.build, "a document run is not a build run");
    }
}

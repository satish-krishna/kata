//! The run-spec of a run of a change.

use crate::permissions::RunPlace;
use kata_core::spec::PermissionMode;
use kata_core::RunSpec;

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

/// The run-spec of a run of a change.
pub fn change_spec(_place: &RunPlace, _form: RunForm) -> RunSpec {
    RunSpec::default()
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

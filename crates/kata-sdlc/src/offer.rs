//! What a change shows and offers: its stage, its label and the actions the Workbench puts on it, decided
//! from the plugin's answer (`ChangeState`) and the few facts only the Workbench has (`LiveFacts`).
//! The frontend arranges this answer; it decides nothing.
use crate::ai_sdlc::state::ChangeState;
use serde::{Deserialize, Serialize};

/// What only the Workbench knows about a change right now. Per change: another change's run never counts.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct LiveFacts {
    /// A run of this change is live.
    pub run_live: bool,
    /// Its build has a stopped repository.
    pub build_stopped: bool,
    /// Its build is live.
    pub build_live: bool,
}

/// Why an accepted plan cannot be built.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum OutOfDateCause {
    /// The spec no longer matches the intent it was written from.
    SpecPin,
    /// The plan no longer matches the spec that is accepted now.
    PlanPin,
}

/// Where a change is, as the Workbench shows it. Named `OfferStage` because `changes::Stage` still exists.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum OfferStage {
    IntentInProgress,
    IntentAwaiting,
    IntentAcceptedUncommitted,
    Rejected,
    SpecReady,
    SpecAwaiting,
    SpecAcceptedUncommitted,
    PlanReady,
    PlanAwaiting,
    PlanAcceptedUncommitted,
    PlanOutOfDate { cause: OutOfDateCause },
    PlanUnreadable,
    PlanSuperseded,
    BuildReady,
    BuildStopped,
    BuildFinished,
    FixInProgress,
    FixUnsettled,
    FixAwaiting,
    FixAccepting,
}

/// The step a label belongs to.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum LabelStep {
    Intent,
    Spec,
    Plan,
    Build,
    Done,
    Closed,
}

/// How a label is colored.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum LabelTone {
    Success,
    Warning,
    Muted,
    Error,
}

/// The words a stage is shown with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct StageLabel {
    pub step: LabelStep,
    pub text: String,
    pub tone: LabelTone,
}

/// Something the engineer can do to a change.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub enum StageAction {
    ContinueIntent,
    AcceptIntent,
    RejectIntent,
    CommitAcceptance,
    StartSpec,
    ContinueSpec,
    AcceptSpec,
    StartPlan,
    RerunPlan,
    ReopenSpec,
    ReopenIntent,
    AcceptPlan,
    StartBuild,
    ContinueBuild,
    AnotherRound,
    RunReview,
    DeclareDone,
    CancelBuild,
    FinishFixDraft,
    AcceptFix,
    ChangeFix,
    ReopenFix,
    FullPipelineInstead,
    RejectFix,
    /// Renaming the change's branch.
    Rename,
}

/// An action with the answer to "may the engineer use it now".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct OfferedAction {
    pub action: StageAction,
    pub enabled: bool,
    /// Why it is refused: the plugin's own stop text where the plugin refused, verbatim.
    pub reason: Option<String>,
    /// The feedback box refuses an empty answer for this action.
    pub feedback_required: bool,
    /// The action regenerates a document that already exists, so the operator can say what should change.
    pub revisits: bool,
}

/// What a change shows and offers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeOffer {
    pub stage: OfferStage,
    pub label: StageLabel,
    pub actions: Vec<OfferedAction>,
}

/// What a change shows and offers, from the plugin's answer and the Workbench's live facts.
pub fn of(change: &ChangeState, live: &LiveFacts) -> ChangeOffer {
    let _ = (change, live);
    unimplemented!("offer::of")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_sdlc::state::{
        BuildLogState, ChangeTrack, Ready, ReadyGate, RepoTasks, ReviewDraft, ReviewState,
        SourcePin, StateDocument, StateDocuments,
    };
    use crate::format::{FixAccepted, FixDocumentFacts, FixFacts, FixState};
    use std::collections::BTreeMap;

    const NOT_LIVE: LiveFacts = LiveFacts {
        run_live: false,
        build_stopped: false,
        build_live: false,
    };

    fn accepted_doc(pin: Option<SourcePin>) -> StateDocument {
        StateDocument {
            exists: true,
            in_head: true,
            head_status: Some("accepted".into()),
            working_status: Some("accepted".into()),
            uncommitted: false,
            pin,
        }
    }

    fn open_gate() -> ReadyGate {
        ReadyGate {
            candidate: false,
            stop: None,
            accept: vec![],
        }
    }

    /// A full-track change with every document accepted and committed, one task logged and one not.
    fn base() -> ChangeState {
        let mut tasks = BTreeMap::new();
        tasks.insert(
            "app".to_string(),
            RepoTasks {
                all: vec!["T1".into(), "T2".into()],
                logged: vec!["T1".into()],
                unlogged: vec!["T2".into()],
                commits: None,
                untasked: None,
                uncommitted: None,
            },
        );
        ChangeState {
            change: "2026-11-01-a".into(),
            master: "/ws/ai-sdlc".into(),
            folder: "/ws/ai-sdlc/intent/demo/2026-11-01-a".into(),
            in_copy: false,
            title: Some("A".into()),
            track: ChangeTrack::Full,
            documents: StateDocuments {
                intent: accepted_doc(None),
                spec: accepted_doc(Some(SourcePin::Holds)),
                plan: accepted_doc(Some(SourcePin::Holds)),
            },
            scenarios: Some(2),
            tasks: Some(tasks),
            build_logs: BTreeMap::<String, BuildLogState>::new(),
            review: ReviewState {
                committed: 0,
                draft: ReviewDraft::None,
            },
            fix: None,
            ready: Ready {
                spec: open_gate(),
                plan: open_gate(),
                build: open_gate(),
                review: open_gate(),
                done: open_gate(),
                reject: open_gate(),
            },
        }
    }

    fn set_status(doc: &mut StateDocument, status: &str) {
        doc.working_status = Some(status.into());
    }

    fn all_logged(c: &mut ChangeState) {
        let app = c.tasks.as_mut().unwrap().get_mut("app").unwrap();
        app.logged = app.all.clone();
        app.unlogged.clear();
    }

    fn fix_doc() -> FixDocumentFacts {
        FixDocumentFacts {
            in_head: true,
            head_status: Some("draft".into()),
            working_status: Some("draft".into()),
        }
    }

    fn fix_at(row: u8) -> FixState {
        FixState {
            row,
            facts: FixFacts {
                intent: fix_doc(),
                spec: fix_doc(),
                plan: fix_doc(),
                unrecorded: vec![],
                own_lines_only: false,
                accepted: FixAccepted::None,
                acceptance_last: false,
                built: false,
            },
        }
    }

    fn fix(row: Option<u8>) -> ChangeState {
        let mut c = base();
        c.track = ChangeTrack::Fix;
        c.fix = row.map(fix_at);
        c
    }

    fn stage_of(c: &ChangeState, live: &LiveFacts) -> OfferStage {
        of(c, live).stage
    }

    #[test]
    fn full_track_stage_rows() {
        use OfferStage::*;
        let stopped = LiveFacts {
            build_stopped: true,
            ..NOT_LIVE
        };
        type Edit = fn(&mut ChangeState);
        let rows: Vec<(u8, Edit, LiveFacts, OfferStage)> = vec![
            (
                1,
                |c| c.documents.intent.head_status = Some("rejected".into()),
                NOT_LIVE,
                Rejected,
            ),
            (
                2,
                |c| {
                    set_status(&mut c.documents.intent, "draft");
                    c.documents.intent.uncommitted = true;
                },
                NOT_LIVE,
                IntentInProgress,
            ),
            (
                3,
                |c| set_status(&mut c.documents.intent, "draft"),
                NOT_LIVE,
                IntentAwaiting,
            ),
            (
                4,
                |c| c.documents.intent.uncommitted = true,
                NOT_LIVE,
                IntentAcceptedUncommitted,
            ),
            (5, |c| c.documents.spec.exists = false, NOT_LIVE, SpecReady),
            (
                6,
                |c| set_status(&mut c.documents.spec, "draft"),
                NOT_LIVE,
                SpecAwaiting,
            ),
            (
                7,
                |c| c.documents.spec.uncommitted = true,
                NOT_LIVE,
                SpecAcceptedUncommitted,
            ),
            (
                8,
                |c| c.documents.spec.pin = Some(SourcePin::Broken),
                NOT_LIVE,
                PlanOutOfDate {
                    cause: OutOfDateCause::SpecPin,
                },
            ),
            (9, |c| c.documents.plan.exists = false, NOT_LIVE, PlanReady),
            (
                10,
                |c| set_status(&mut c.documents.plan, "superseded"),
                NOT_LIVE,
                PlanSuperseded,
            ),
            (
                11,
                |c| set_status(&mut c.documents.plan, "draft"),
                NOT_LIVE,
                PlanAwaiting,
            ),
            (
                12,
                |c| c.documents.plan.uncommitted = true,
                NOT_LIVE,
                PlanAcceptedUncommitted,
            ),
            (
                13,
                |c| c.documents.plan.pin = Some(SourcePin::Missing),
                NOT_LIVE,
                PlanOutOfDate {
                    cause: OutOfDateCause::PlanPin,
                },
            ),
            (14, |c| c.tasks = None, NOT_LIVE, PlanUnreadable),
            (15, |_| {}, stopped, BuildStopped),
            (16, |_| {}, NOT_LIVE, BuildReady),
            (17, all_logged, NOT_LIVE, BuildFinished),
        ];
        assert_eq!(rows.len(), 17);
        for (row, edit, live, expected) in rows {
            let mut c = base();
            edit(&mut c);
            assert_eq!(stage_of(&c, &live), expected, "row {row}");
        }

        // First match wins: a rejected intent beats everything after it, and an unaccepted intent beats
        // a spec that does not exist.
        let mut c = base();
        c.documents.intent.head_status = Some("rejected".into());
        c.documents.spec.exists = false;
        assert_eq!(stage_of(&c, &NOT_LIVE), Rejected);
        let mut c = base();
        set_status(&mut c.documents.intent, "draft");
        c.documents.spec.exists = false;
        assert_eq!(stage_of(&c, &NOT_LIVE), IntentAwaiting);
        // Finished tasks beat a stopped repository.
        let mut c = base();
        all_logged(&mut c);
        assert_eq!(stage_of(&c, &stopped), BuildFinished);
    }

    fn reasons(offer: &ChangeOffer) -> Vec<(StageAction, bool, Option<String>)> {
        offer
            .actions
            .iter()
            .map(|a| (a.action, a.enabled, a.reason.clone()))
            .collect()
    }

    fn find(offer: &ChangeOffer, action: StageAction) -> &OfferedAction {
        offer
            .actions
            .iter()
            .find(|a| a.action == action)
            .unwrap_or_else(|| panic!("{action:?} not listed in {:?}", reasons(offer)))
    }

    const SPEC_STOP: &str = "This intent is `draft`. The product owner accepts it by changing its status to `accepted` and committing; the spec runs only after that.";

    #[test]
    fn offered_action_follows_the_plugin_answer() {
        use StageAction::*;
        let spec_ready = || {
            let mut c = base();
            c.documents.spec.exists = false;
            c
        };
        let plan_ready = || {
            let mut c = base();
            c.documents.plan.exists = false;
            c
        };
        // spec: ready
        let offer = of(&spec_ready(), &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::SpecReady);
        let a = find(&offer, StartSpec);
        assert!(a.enabled);
        assert_eq!(a.reason, None);
        // spec: stopped with a message
        let mut c = spec_ready();
        c.ready.spec.stop = Some("the spec stop".into());
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, StartSpec);
        assert!(!a.enabled);
        assert_eq!(a.reason.as_deref(), Some("the spec stop"));
        // plan: ready
        let offer = of(&plan_ready(), &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::PlanReady);
        assert!(find(&offer, StartPlan).enabled);
        // plan: stopped
        let mut c = plan_ready();
        c.ready.plan.stop = Some("the plan stop".into());
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, StartPlan);
        assert!(!a.enabled);
        assert_eq!(a.reason.as_deref(), Some("the plan stop"));
        // build: ready
        let offer = of(&base(), &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::BuildReady);
        assert!(find(&offer, StartBuild).enabled);
        // build: stopped, for a start and for a continue
        let mut c = base();
        c.ready.build.stop = Some("the build stop".into());
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, StartBuild);
        assert!(!a.enabled);
        assert_eq!(a.reason.as_deref(), Some("the build stop"));
        let offer = of(
            &c,
            &LiveFacts {
                build_stopped: true,
                ..NOT_LIVE
            },
        );
        assert_eq!(offer.stage, OfferStage::BuildStopped);
        for action in [ContinueBuild, AnotherRound] {
            let a = find(&offer, action);
            assert!(!a.enabled, "{action:?}");
            assert_eq!(a.reason.as_deref(), Some("the build stop"));
        }
        // review: ready
        let mut finished = base();
        all_logged(&mut finished);
        let offer = of(&finished, &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::BuildFinished);
        assert!(find(&offer, RunReview).enabled);
        // review: stopped
        let mut c = finished.clone();
        c.ready.review.stop = Some("the review stop".into());
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, RunReview);
        assert!(!a.enabled);
        assert_eq!(a.reason.as_deref(), Some("the review stop"));
        // done: waiting for it
        let mut c = finished.clone();
        c.ready.done.candidate = true;
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, DeclareDone);
        assert!(a.enabled);
        assert_eq!(a.reason, None);
        // A gate's stop never refuses another step's action.
        let mut c = finished;
        c.ready.build.stop = Some("the build stop".into());
        let offer = of(&c, &NOT_LIVE);
        assert!(find(&offer, RunReview).enabled);
        assert!(find(&offer, DeclareDone).enabled);
        assert!(!find(&offer, AnotherRound).enabled);
    }

    #[test]
    fn the_refusal_is_the_plugins_message_verbatim() {
        // The grammar's spec stop, with the status filled in.
        let grammar = include_str!("../tests/ai-sdlc-tools/GRAMMAR.md");
        assert!(grammar.contains(
            "The product owner accepts it by changing its status to `accepted` and committing; the spec runs only after that."
        ));
        let mut c = base();
        c.documents.spec.exists = false;
        c.ready.spec.stop = Some(SPEC_STOP.into());
        let offer = of(&c, &NOT_LIVE);
        let a = find(&offer, StageAction::StartSpec);
        assert!(!a.enabled);
        assert_eq!(a.reason.as_deref(), Some(SPEC_STOP));
        // The same on the spec's other action.
        let mut c = base();
        set_status(&mut c.documents.spec, "draft");
        c.ready.spec.stop = Some(SPEC_STOP.into());
        let offer = of(&c, &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::SpecAwaiting);
        let a = find(&offer, StageAction::ContinueSpec);
        assert_eq!(a.reason.as_deref(), Some(SPEC_STOP));
    }

    #[test]
    fn fix_rows_give_the_plugins_fix_stage() {
        use OfferStage::*;
        let table: [(Option<u8>, OfferStage); 11] = [
            (Some(1), Rejected),
            (Some(2), FixUnsettled),
            (Some(3), FixInProgress),
            (Some(4), FixAccepting),
            (Some(5), FixAccepting),
            (Some(6), FixAwaiting),
            (Some(7), FixAwaiting),
            (Some(8), BuildReady),
            (Some(9), FixUnsettled),
            (Some(0), FixUnsettled),
            (None, FixUnsettled),
        ];
        for (row, expected) in table {
            assert_eq!(stage_of(&fix(row), &NOT_LIVE), expected, "row {row:?}");
        }
        // Row 8 gives the plan rows.
        let stopped = LiveFacts {
            build_stopped: true,
            ..NOT_LIVE
        };
        assert_eq!(stage_of(&fix(Some(8)), &stopped), BuildStopped);
        let mut c = fix(Some(8));
        all_logged(&mut c);
        assert_eq!(stage_of(&c, &NOT_LIVE), BuildFinished);
        let mut c = fix(Some(8));
        c.documents.plan.pin = Some(SourcePin::Broken);
        assert_eq!(
            stage_of(&c, &NOT_LIVE),
            PlanOutOfDate {
                cause: OutOfDateCause::PlanPin
            }
        );
        // A rejected intent is closed whatever the row says.
        let mut c = fix(Some(6));
        c.documents.intent.head_status = Some("rejected".into());
        assert_eq!(stage_of(&c, &NOT_LIVE), Rejected);

        // The plugin's words: the label of an unreadable fix says so.
        assert_eq!(
            of(&fix(None), &NOT_LIVE).label.text,
            "Fix · could not be read"
        );
        assert_eq!(
            of(&fix(Some(2)), &NOT_LIVE).label.text,
            "Fix · statuses not settled"
        );

        // The actions of the fix rows, reject-fix with the awaiting and accepting ones.
        use StageAction::*;
        let names = |c: &ChangeState| -> Vec<StageAction> {
            of(c, &NOT_LIVE).actions.iter().map(|a| a.action).collect()
        };
        assert_eq!(names(&fix(Some(3))), [FinishFixDraft, Rename]);
        assert_eq!(
            names(&fix(Some(6))),
            [AcceptFix, ChangeFix, FullPipelineInstead, RejectFix, Rename]
        );
        assert_eq!(
            names(&fix(Some(7))),
            [AcceptFix, ChangeFix, RejectFix, Rename]
        );
        assert_eq!(
            names(&fix(Some(4))),
            [AcceptFix, ChangeFix, RejectFix, Rename]
        );
        assert_eq!(names(&fix(Some(2))), [Rename]);
        assert_eq!(names(&fix(Some(8))), [StartBuild, ReopenFix, Rename]);
        // Reopening a fix needs feedback, except when only a pin broke.
        let mut c = fix(Some(8));
        c.documents.plan.pin = Some(SourcePin::Broken);
        let offer = of(&c, &NOT_LIVE);
        assert_eq!(reasons(&offer)[0].0, ReopenFix);
        assert!(!find(&offer, ReopenFix).feedback_required);
        let offer = of(&fix(Some(8)), &NOT_LIVE);
        assert!(find(&offer, ReopenFix).feedback_required);
        let offer = of(&fix(Some(7)), &NOT_LIVE);
        assert!(find(&offer, ChangeFix).feedback_required);
        assert!(find(&offer, ChangeFix).revisits);
        assert!(!find(&offer, AcceptFix).revisits);
    }

    #[test]
    fn rename_is_not_offered_while_a_run_is_live() {
        let running = LiveFacts {
            run_live: true,
            build_live: true,
            ..NOT_LIVE
        };
        let offer = of(&base(), &running);
        let rename = find(&offer, StageAction::Rename);
        assert!(!rename.enabled);
        assert_eq!(
            rename.reason.as_deref(),
            Some("A run of this change is live.")
        );
        // Idle, rename is offered.
        let offer = of(&base(), &NOT_LIVE);
        let rename = find(&offer, StageAction::Rename);
        assert!(rename.enabled);
        assert_eq!(rename.reason, None);
        // R11.6: the facts are per change, so nothing here is refused when this change has no live run.
        assert!(offer.actions.iter().all(|a| a.enabled));
        // Not offered at all before the intent is accepted.
        let mut c = base();
        set_status(&mut c.documents.intent, "draft");
        assert!(of(&c, &NOT_LIVE)
            .actions
            .iter()
            .all(|a| a.action != StageAction::Rename));
    }

    #[test]
    fn a_rejected_intent_is_closed_and_offers_nothing() {
        // The abandon has not finished: the copy still holds a draft working copy.
        let mut c = base();
        c.documents.intent.head_status = Some("rejected".into());
        set_status(&mut c.documents.intent, "draft");
        c.documents.intent.uncommitted = true;
        let offer = of(&c, &NOT_LIVE);
        assert_eq!(offer.stage, OfferStage::Rejected);
        assert!(offer.actions.is_empty());
        assert_eq!(offer.label.text, "Closed · rejected");
        assert_eq!(offer.label.step, LabelStep::Closed);
        assert_eq!(offer.label.tone, LabelTone::Error);
    }

    #[test]
    fn enable_rows() {
        use StageAction::*;
        let stops = |c: &mut ChangeState| {
            c.ready.spec.stop = Some("S".into());
            c.ready.plan.stop = Some("P".into());
            c.ready.build.stop = Some("B".into());
            c.ready.review.stop = Some("R".into());
            c.ready.reject.stop = Some("X".into());
        };
        let live = LiveFacts {
            run_live: true,
            ..NOT_LIVE
        };
        let check = |c: &ChangeState,
                     l: &LiveFacts,
                     action: StageAction,
                     enabled: bool,
                     why: Option<&str>| {
            let offer = of(c, l);
            let a = find(&offer, action);
            assert_eq!(
                (a.enabled, a.reason.as_deref()),
                (enabled, why),
                "{action:?} at {:?}",
                offer.stage
            );
        };
        // Row 1 beats the gates: a live run refuses with its own message, not the plugin's.
        let mut c = base();
        c.documents.spec.exists = false;
        stops(&mut c);
        check(
            &c,
            &live,
            StartSpec,
            false,
            Some("A run of this change is live."),
        );
        // Row 2.
        check(&c, &NOT_LIVE, StartSpec, false, Some("S"));
        let mut awaiting = base();
        set_status(&mut awaiting.documents.spec, "draft");
        stops(&mut awaiting);
        check(&awaiting, &NOT_LIVE, ContinueSpec, false, Some("S"));
        // Row 3.
        let mut c = base();
        c.documents.plan.exists = false;
        stops(&mut c);
        check(&c, &NOT_LIVE, StartPlan, false, Some("P"));
        let mut c = base();
        set_status(&mut c.documents.plan, "superseded");
        stops(&mut c);
        check(&c, &NOT_LIVE, RerunPlan, false, Some("P"));
        // Row 4.
        let mut c = base();
        stops(&mut c);
        check(&c, &NOT_LIVE, StartBuild, false, Some("B"));
        // Row 5.
        let mut c = base();
        all_logged(&mut c);
        stops(&mut c);
        check(&c, &NOT_LIVE, RunReview, false, Some("R"));
        check(&c, &NOT_LIVE, AnotherRound, false, Some("B"));
        // Row 5a.
        let mut c = base();
        set_status(&mut c.documents.intent, "draft");
        stops(&mut c);
        check(&c, &NOT_LIVE, RejectIntent, false, Some("X"));
        check(&c, &NOT_LIVE, AcceptIntent, true, None);
        let mut c = fix(Some(6));
        stops(&mut c);
        check(&c, &NOT_LIVE, RejectFix, false, Some("X"));
        // Row 6: any other.
        let mut c = base();
        stops(&mut c);
        check(&c, &NOT_LIVE, ReopenSpec, true, None);
        check(&c, &NOT_LIVE, ReopenIntent, true, None);
        // Declare done is never refused by a gate.
        let mut c = base();
        all_logged(&mut c);
        stops(&mut c);
        c.ready.done.stop = None;
        check(&c, &NOT_LIVE, DeclareDone, true, None);
        // ... but a live run of this change refuses it like every other action.
        check(
            &c,
            &live,
            DeclareDone,
            false,
            Some("A run of this change is live."),
        );
    }
}

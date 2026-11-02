---
name: kata-architecture
description: Use this skill when checking a spec, a plan or a change for Kata against its architecture policy, or before deciding where a piece of Workbench behavior is computed. The Rust backend owns every decision; the Angular ViewModels only arrange what the backend decided for the screen. Covers where a rule lives, previews that must match their action, lists across the Tauri boundary, and operations across several repositories.
user-invocable: true
---

# Kata architecture policy

Rust is the brains of Kata. The Workbench frontend is presentational. This policy says what that means precisely enough to decide every case, and what to flag when a spec, a plan or a diff breaks it.

## 1. Decisions live in Rust

A rule a spec scenario, a context file rule or a decision table states is computed in Rust (`kata-sdlc` for the AI-SDLC mode, `kata-core` for the engine), reached through a Tauri command, and handed to the frontend as data through the ts-rs bindings. That covers which records take part, what is picked or refused by default, what blocks an action, how things are grouped and ordered when the spec says so, what counts as stale, and every outcome a decision table settles.

A TypeScript ViewModel may:

- filter, fold, hide or show what the backend sent, according to screen state (a selected filter, an open fold, a picked row, a tab);
- hold form state before it is submitted (what is ticked, what is typed);
- format text for display (truncate, pluralize, label);
- map backend data onto presentational components.

A rule the ai-sdlc plugin owns is asked of the plugin by the backend through `ai_sdlc` and passed on as data; it is never re-derived in Rust or TypeScript.

The test: if the answer is the same whatever the screen state, and a spec scenario or a context rule asserts it, it is a decision and belongs in Rust. "Most serious first" is a decision; "the low findings are folded until clicked" is arrangement.

## 2. One computation per decision

A preview and the action it previews use the same Rust call. When a dialog shows what will happen ("these repositories get an agent, with these findings"), it asks the backend with the form state and shows the answer, and starting the action sends the same form state to the same computation. A TypeScript copy kept for instant feedback is a second implementation, and the two drift.

## 3. Lists cross the boundary as lists

When the frontend needs a backend command for several items and the command takes one, change the command. Never loop over a single-item command in TypeScript and merge the results: the merge is logic, and the loop breaks any promise the command makes about the whole set.

## 4. Operations across repositories are all-or-nothing

An operation that touches several repositories (preparing a build, creating branches, renaming) checks every repository before it changes any, and reports every problem and every leftover together, in one answer. Half the repositories changed and half refused is never an outcome.

## 5. Existing logic in TypeScript

This is the decision logic TypeScript still holds. None of it is precedent: do not copy it and do not add a decision to it. Moving an item is a change of its own, unless the change at hand already rewrites that code. When an item moves, delete it here in the same change.

Rules a spec or a context file states, computed in TypeScript:

- `rulePath`, `productRepoRules` and `restrictedFor` in `app/src/app/lib/sdlc.ts` build deny rules for setup, context, triage, fix and new-change runs, and duplicate `kata_sdlc::permissions::rule_path`, the owner of the rule shape.
- `stageRuns`, `stagePills` and `primaryAction` in `app/src/app/lib/sdlc.ts`: which runs belong to a stage (with the fallback by deterministic run name), which stage pills are open, accepted or locked, and which action is primary.
- `reviewFindings` and `mostSeriousFirst` in `app/src/app/lib/sdlc.ts`, `shownReview` and `shownSection` in `app/src/app/lib/sdlc-review.ts`, and `groupFindings` in `app/src/app/lib/sdlc-findings.ts`: which findings a change shows (the review document over the review run's words), their order, most serious first, and their grouping by repository.
- `shownDocument`, `shownBuild`, `shownPart` and `shownChangeList` in `app/src/app/lib/doc-notice.ts`: the decision table for what a spec, plan, build log or review shows and which notice goes above it.
- `buildStage` and `taskGroups` in `app/src/app/lib/build-stage.ts` (a change declared done is done whatever the build session says; which repositories the tasks area lists), and `layoutStage` in `app/src/app/lib/build-layout-stage.ts` (where the build stands for the layout).
- `sessionsFor` and `activityFor` in `app/src/app/lib/build-sessions.ts`: which session a picked task shows (the latest of several links counts) and the default pick.
- `isSetUp` and `contextAction` in `app/src/app/lib/sdlc-workspace.ts`: when a workspace counts as set up, and which context action a repository row offers.
- `reviewEntry` in `app/src/app/sdlc/build/build-page.view-model.ts` counts a review the build just finished and read as finished before the run links catch up. The review's standing itself is `kata_sdlc::review::standing`, and where each repository and task stands is `kata_sdlc::board`.

Single-item commands looped in TypeScript (section 3):

- `sdlcDiffFiles` per repository in `readChanges` of `app/src/app/sdlc/build/build-page.view-model.ts`, and `sdlcDiffFiles` and `sdlcCommitFiles` per repository in `app/src/app/sdlc/changes/changes-view.view-model.ts`.
- `sdlcContextHealth` per repository in `readContextStates` of `app/src/app/lib/sdlc-workspace.ts`, which the home calls.
- `previewRun` per section in `app/src/app/core/given/run-preview.view-model.ts`.

The browser mock (`app/src/app/lib/sdlc-mock.ts`) restates some backend decisions, `mockBoard` and `mockStanding` among them, so the browser and the unit tests have answers where no backend runs. That is a fixture, not a second owner: the Rust tests own the rows, and a mock answer that drifts from them is a mock bug.

## Checking a document or a diff

- **Spec:** a design that has the Workbench frontend decide something a requirement states is an area of concern owned by the Maintainer. So is a preview the design computes separately from its action.
- **Plan:** every shared decision whose answer is a rule names a Rust function or type as its owner; a TypeScript owner for a rule is a gap. A task whose Tests assert a rule through a ViewModel alone, with no backend test, is a gap.
- **Diff:** a new rule in a ViewModel or under `app/src/app/lib/`, a TypeScript loop over a backend command, or a multi-repository operation that can stop halfway is a finding.

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

The test: if the answer is the same whatever the screen state, and a spec scenario or a context rule asserts it, it is a decision and belongs in Rust. "Most serious first" is a decision; "the low findings are folded until clicked" is arrangement.

## 2. One computation per decision

A preview and the action it previews use the same Rust call. When a dialog shows what will happen ("these repositories get an agent, with these findings"), it asks the backend with the form state and shows the answer, and starting the action sends the same form state to the same computation. A TypeScript copy kept for instant feedback is a second implementation, and the two drift.

## 3. Lists cross the boundary as lists

When the frontend needs a backend command for several items and the command takes one, change the command. Never loop over a single-item command in TypeScript and merge the results: the merge is logic, and the loop breaks any promise the command makes about the whole set.

## 4. Operations across repositories are all-or-nothing

An operation that touches several repositories (preparing a build, creating branches, renaming) checks every repository before it changes any, and reports every problem and every leftover together, in one answer. Half the repositories changed and half refused is never an outcome.

## 5. Existing logic in TypeScript

Some decisions predate this policy and still live in TypeScript: the build driver (`app/src/app/sdlc/build/build-driver.ts`) and helpers under `app/src/app/lib/` such as the build permission rules in `sdlc.ts`. The build tab findings and rounds change (2026-10-30) added more before this policy existed: the round offer, default picks, round plan and finding keys in `app/src/app/lib/build-round.ts`, and the review rows' severity order, counts and low split in `reviewRows` (`app/src/app/lib/build-task-list.ts`). They are debt, recorded here so nobody copies them as precedent. A change may not add a new decision to them. Moving one is a change of its own, unless the change at hand already rewrites that decision. The build driver and the decisions above move to Rust with the per-change worktree change.

## Checking a document or a diff

- **Spec:** a design that has the Workbench frontend decide something a requirement states is an area of concern owned by the Maintainer. So is a preview the design computes separately from its action.
- **Plan:** every shared decision whose answer is a rule names a Rust function or type as its owner; a TypeScript owner for a rule is a gap. A task whose Tests assert a rule through a ViewModel alone, with no backend test, is a gap.
- **Diff:** a new rule in a ViewModel or under `app/src/app/lib/`, a TypeScript loop over a backend command, or a multi-repository operation that can stop halfway is a finding.

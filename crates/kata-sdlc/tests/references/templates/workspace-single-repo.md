# ai-sdlc repository

This repository is its own ai-sdlc master (single-repo layout): the product's code, the marker `.ai-sdlc.json` and the ai-sdlc documents under `intent/` all live here. It holds one system, `<system>`, made of the apps below; each app is a folder of this repository. Work in a sibling folder of this repository is not part of the system, and these instructions do not apply to it.

The ai-sdlc setup skill generates this text from `.ai-sdlc.json`. To change it, change the marker and rerun setup rather than editing it.

## Apps

| App | Folder | Context | Staleness check |
|---|---|---|---|
| <app> | `<folder>` | `intent/<system>/context/<app>.md` | `<check>` |

The system's policies are in `intent/<system>/policies.md`; a policy row that names an app applies only to changes that touch that app.

## Before designing anything

Before writing a spec, a design, a plan, or a proposal that changes how the system behaves:

1. Work out which apps the work touches, from the table above.
2. Read the context file of every app it touches. It describes what the app does in business terms. If it does not exist yet, say so; the ai-sdlc context skill builds it.
3. Read the system's `policies.md` for the policy areas and their owners.
4. Before relying on a context file, compare its `source_commit` with the app: run the app's staleness check from the table, with the file's `source_commit` in place of `<source_commit>`. If the count is above zero, or the command fails because the commit no longer exists, say that the file may be out of date; the ai-sdlc context skill refreshes it.

How to read a context file:

- Under **Rules the system enforces**, each rule carries one tag. `seen in code` and `confirmed by engineer` describe current, deliberate behavior that a design keeps unless it says otherwise and names who has to agree. `intent unknown` is an open question: the code does it, but nobody could say whether it is still wanted, so a design must not settle it on its own; ask the product owner.
- **Known oddities** are workarounds, leftovers and special cases, recorded without judgment; never treat one as current behavior to keep. One the engineer called a bug or obsolete (its text says so) can be dropped. Any other oddity a design touches is an open question, like an `intent unknown` rule: ask the product owner rather than keeping it or designing it away.

## Working in an app

Each app's own instructions govern code inside it: a `CLAUDE.md` in its folder, `CONTRIBUTING.md`, coding conventions, and lint or formatter configuration. Apps differ in their build and test commands, so run an app's own, from its folder.

## How changes are made

Not sure which track a request takes? The ai-sdlc `start` skill takes a brief description of anything, from a feature to a bug, and routes it. A bug fix or a small enhancement that stays in one app, changes no business rule in its context file and fits in three plan tasks takes the light track: the ai-sdlc `fix` skill writes and accepts its documents in one run, then `build` and `review` run as for any change. Any other change goes through the ai-sdlc skills in order, each with its own document under `intent/<system>/<change>/`: `intent` (the product owner's what and why), `spec`, `plan`, then `build` for each app the plan names.

A session given a plan task (a brief naming a task `T<n>` and the scenarios it covers) works from that brief: the brief is its scope, and it does not reread every context file.

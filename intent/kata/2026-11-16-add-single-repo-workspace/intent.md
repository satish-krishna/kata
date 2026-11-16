---
title: Add a single-repo repository from the Add workspace dialog
system: kata
author: SatishKrishna Pilla, engineer
date: 2026-11-16
status: accepted
scope: kata
track: fix
kind: bug
context: [kata@ac8191b]
---

# Intent: Add a single-repo repository from the Add workspace dialog

## Problem

An engineer who picks a single-repo repository (a repository that holds its own hoshin records, as Kata itself does) in the Workbench's Add workspace dialog is told "No git repositories found in this folder. Nothing to add." and gets no Add button. Context rule C150 says such a repository opens from its own folder, a folder inside it or its parent, and is saved in the same list as workspaces. So the engineer cannot use the AI-SDLC mode on a single-repo system at all from a fresh machine.

## Root cause

The scan of a single-repo repository (`scan_single_repo`, `crates/kata-sdlc/src/workspace.rs:103`) lists no sibling repositories on purpose, so its `repos` is empty. The frontend reads an empty `repos` as "the folder holds no git repository": the add flow in `app/src/app/sdlc/home/sdlc-home.view-model.ts` (the `scan.repos.length === 0` branch of `addWorkspace`) and the dialog's `canAdd` and first template branch in `app/src/app/ui/add-workspace-dialog.ts` and `.html`.

## Proposed outcome

Picking a set-up single-repo repository in Add workspace offers Add workspace, and adding it saves it as a single-repo entry. A folder that really holds no git repository is still refused with the same message.

## Affected users and systems

- **Users:** engineers adding a single-repo repository to the Workbench's AI-SDLC mode.
- **Systems:** the `kata` app: the workspace scan in the AI-SDLC backend and the Workbench's add flow and dialog.

## Decisions

| # | Situation | Decision | What should happen |
|---|---|---|---|
| D1 | Whether a folder holds no git repository is a decision the frontend makes today from the length of `repos` | handle it | The backend's scan says it, and the add flow and the dialog read that answer, as the architecture policy asks of every decision. |

## Open questions

None.

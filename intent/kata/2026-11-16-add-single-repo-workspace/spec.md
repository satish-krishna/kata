---
layout: 2
source_intent: 2026-11-16-add-single-repo-workspace/intent.md
source_intent_commit: pending acceptance
system: kata
date: 2026-11-16
status: draft
policies_applied: []
policies_not_checked: [security, compliance, brand, UX, architecture]
---

# Spec: Add a single-repo repository from the Add workspace dialog

## Requirements

```gherkin
Feature: Add a single-repo repository from the Add workspace dialog
  A set-up single-repo repository can be added from the Add workspace dialog, and a folder with no git repository still cannot.

  @R1 @from:problem
  Rule: The Add workspace dialog refuses a folder only when it holds no git repository, and a single-repo repository is one

    @R1.1
    Scenario: A set-up single-repo repository can be added
      Given a single-repo repository whose hoshin marker is committed, which has no sibling repositories
      When the engineer picks its folder in Add workspace
      Then the dialog shows its systems and offers Add workspace
      And it does not say that no git repositories were found

    @R1.2
    Scenario: A folder with no git repository is still refused
      Given a folder that holds no git repository
      When the engineer picks it in Add workspace
      Then the dialog says no git repositories were found
      And it offers no Add workspace
```

## Design

The workspace scan (`WorkspaceScan` in `crates/kata-sdlc/src/workspace.rs`) gains a field that says whether the folder holds no git repository at all: true for a workspace scan with no repository directly inside it, false for every single-repo scan, which is itself a repository though it lists no siblings. The add flow in the home ViewModel and the Add workspace dialog read that field in place of the length of `repos`, which removes the root cause and moves the decision to the backend (D1). Saving the folder already records the single-repo layout (`sdlc_add_workspace` in `app/src-tauri/src/lib.rs`), so nothing changes there.

## Out of scope

- The dialog's table for a single-repo repository lists the repository itself as master; listing its apps there, as the home does, is not part of this fix.
- A single-repo repository whose marker is not committed: C150 leaves its setup to the plugin's setup skill, and this fix does not change what the Workbench offers for it.
- The "Scan folder for repos" step of the add progress still counts sibling repositories (0 for a single-repo repository).

## Areas of concern

1. **Policy areas not checked.** The light track does not apply policy skills. Owner: the engineer who accepts the fix.

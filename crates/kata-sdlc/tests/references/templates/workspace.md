# hoshin workspace

This folder is a multi-repository workspace: several git repositories checked out side by side. `<master>` is the master repository; it holds the hoshin documents for the systems below, and its `.hoshin.json` says which repositories belong to which system. The master repository and the repositories in the table are part of these systems; any other repository in this folder is not, and these instructions do not apply to work in it.

The hoshin setup skill generates this text from `.hoshin.json`. To change it, change the marker and rerun setup rather than editing it.

## Systems

| System | Repositories | Context | Policies |
|---|---|---|---|
| <system> | <repo>, <repo> | `<master>/intent/<system>/context/` | `<master>/intent/<system>/policies.md` |

## Before designing anything

Before writing a spec, a design, a plan, or a proposal that changes how one of these systems behaves:

1. Work out which system and which repositories the work touches, from the table above.
2. Read the context file of every repository it touches, `<master>/intent/<system>/context/<repo>.md`. It describes what the repository does in business terms. If it does not exist yet, say so; the hoshin context skill builds it.
3. Read the system's `policies.md` for the policy areas and their owners.
4. Before relying on a context file, compare its `source_commit` with the repository: run `git rev-list --count <source_commit>..HEAD -- . ":(exclude)intent" ":(exclude).hoshin.json"` in that repository. If the count is above zero, or the command fails because the commit no longer exists, say that the file may be out of date; the hoshin context skill refreshes it.

How to read a context file:

- Under **Rules the system enforces**, each rule carries one tag. `seen in code` and `confirmed by engineer` describe current, deliberate behavior that a design keeps unless it says otherwise and names who has to agree. `intent unknown` is an open question: the code does it, but nobody could say whether it is still wanted, so a design must not settle it on its own; ask the product owner.
- **Known oddities** are workarounds, leftovers and special cases, recorded without judgment; never treat one as current behavior to keep. One the engineer called a bug or obsolete (its text says so) can be dropped. Any other oddity a design touches is an open question, like an `intent unknown` rule: ask the product owner rather than keeping it or designing it away.

## Working in a repository

Each repository's own instructions govern code inside it: its `CLAUDE.md`, `CONTRIBUTING.md`, coding conventions, and lint or formatter configuration. Its session settings, skills and session hooks load only in a session started inside it. To change code in a repository, start a session inside it; reading another repository's files from here is fine. If the engineer asks for an edit here anyway, read that repository's instructions first and say that its session hooks are not running.

## How changes are made

Not sure which track a request takes? The hoshin `start` skill takes a brief description of anything, from a feature to a bug, and routes it. A bug fix or a small enhancement that stays in one repository, changes no business rule in its context file and fits in three plan tasks takes the light track: the hoshin `fix` skill writes and accepts its documents in one run, then `build` and `review` run as for any change. Any other change goes through the hoshin skills in order, each with its own document under `<master>/intent/<system>/<change>/`: `intent` (the product owner's what and why), `spec`, `plan`, then `build` from inside each repository the plan names.

A session given a plan task (a brief naming a task `T<n>` and the scenarios it covers) works from that brief: the brief is its scope, and it does not reread every context file.

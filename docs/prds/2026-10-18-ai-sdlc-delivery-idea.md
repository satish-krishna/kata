# Idea: AI-SDLC mode, Part 2 (implement, diff, pull requests)

Status: idea, not a PRD. Date: 2026-10-18. Owner: SatishKrishna Pilla.

This is the raw input for the ai-sdlc `intent` interview, written down so it isn't lost. It is deliberately unfinished. The plan is to run it through the ai-sdlc plugin (intent → spec → plan) as the plugin's first real test, so the open questions below are left for the interview to settle rather than answered here. Part 1 is designed in `docs/superpowers/specs/2026-10-18-ai-sdlc-mode-design.md`.

## The idea in a few sentences

Part 1 takes a change from an idea to an accepted spec and a written `plan.md`, all inside the Workbench's AI-SDLC mode. Then the work stops at the edge of the Workbench: someone still has to build the plan, look at what changed across several repositories, and open a pull request in each one. Part 2 closes that gap. Kata runs the implementation from `plan.md`, the Workbench shows what changed in every repository, and when the work is done, every repository the change touched gets a pull request.

## What's already decided

These came out of the Part 1 design conversation and are constraints, not open questions.

- Kata runs the implementation itself, from `plan.md`. Nobody implements it outside kata.
- A change already has a branch in the master repo (`change/<change-folder>`), created by Part 1. Part 2 adds a branch with the same name in each product repo the change touches.
- Once implementation is complete, every repo with changes gets a pull request. That includes the master repo, whose change branch holds `intent.md`, `spec.md` and `plan.md`.
- The Workbench gets a diff explorer that shows what the change did, borrowed from mekiki's (`D:\Repos\experiments\mekiki`, see `docs/architecture/git-diff.md` there). mekiki already treats a workspace as a folder of sibling repos, the same definition kata uses.
- The commit rule from Part 1 carries over: runs commit what the agent wrote, and the Workbench commits what a human decided. Commit messages use the Conventional Commits format.
- The `kata` engine, run-spec and event protocol do not change unless the interview proves it can't be done otherwise. If that happens, it gets raised as its own decision.
- Part 2 reuses Part 1's workspace, change, branch and locked-work machinery rather than adding new versions of them.

## Open questions for the interview

- **Where the pull requests go.** Which hosting service (GitHub, Azure DevOps, something else, more than one), and whose credentials push the branches and open the PRs.
- **What "implementation complete" means.** Tests passing in each repo, a review run, a human clicking Done, or some combination. This gates the PRs.
- **How the plan is executed.** One long run across all repos, one run per repo, or one run per plan task. The engine's default 30-minute leash ends real implementation work partway through, so this also decides the leash settings.
- **Which repos get a branch, and when.** At the start of implementation from the repos the plan names, or lazily, when a run first writes to a repo.
- **What the diff compares.** The change branch against its base in each repo, presumably. Also whether you can look at it while a run is still writing, and whether it is read-only or allows comments that feed the next run.
- **How much of mekiki's diff explorer carries over.** mekiki uses Monaco, and kata's app does not have it yet.
- **Partial failure.** One repo's implementation succeeds and another's fails. What the change looks like then, and whether any PRs open.
- **Plans that change during implementation.** ai-sdlc's `plan` skill says `plan.md` is updated in the same commit as any departure from it. What the Workbench shows when that happens.
- **Merging back.** Whether the Workbench tracks the PRs after opening them (merged, closed, review comments), or its job ends when they are open.

## Why this one is the test case for ai-sdlc

It's real work with a known owner, multiple systems, and genuinely unsettled edge cases, which is what the `intent` interview's triage exists for. It also exercises the parts of the plugin that Part 1 hosts (`intent`, `spec`, `plan` through `ask_user`, acceptance, branch-per-change) on a change whose subject the owner knows well enough to judge the output.

# Example katas

Ready-to-use [run-specs](../../README.md) for the superpowers **brainstorm → plan → execute** workflow. Each `.toml` is one kata: a precise, reproducible form for a single headless `claude -p` run. Copy them into your library or open them in the Workbench, fill in the task, and run.

## The trio

| Kata | Skill it drives | Deliverable | Interactive |
|------|-----------------|-------------|-------------|
| [`brainstorm-feature.toml`](brainstorm-feature.toml) | `kata-brainstorming` | a design doc under `docs/superpowers/specs/` | yes — asks via `ask_user` |
| [`write-plan.toml`](write-plan.toml) | `superpowers:writing-plans` | a reviewable implementation plan under `docs/` | no |
| [`execute-plan.toml`](execute-plan.toml) | `superpowers:subagent-driven-development` | the implemented change (TDD, in a worktree) | no |

They chain: brainstorm produces a spec, write-plan turns that spec into a plan, execute-plan works the plan step by step. Each tightens the leash to fit its job — brainstorm runs in-place with a modest turn cap, while execute-plan isolates in a git worktree, allows more turns, and sets a `max_budget_usd` ceiling.

## Using them

1. **Pick a target.** Every kata ships with `workdir = "."` so it validates anywhere; set it to the repo you want the run to operate on (the Workbench's workdir picker, or edit the field).
2. **Fill the task.** Replace the `<<… >>` placeholder in `task` with your specifics — that line is the override point, not a literal prompt.
3. **Run it.** Either copy the file into your kata library (`~/.kata/katas/`, or `$KATA_HOME/katas/`) to keep it, or run/validate it directly:

   ```sh
   kata validate examples/katas/brainstorm-feature.toml
   kata run      examples/katas/brainstorm-feature.toml
   ```

A real run needs an authenticated `claude` on `PATH`. `bare = false` means the run inherits your logged-in `claude` session and the workspace's ambient `.claude/` skills.

## Notes

- **`brainstorm-feature` uses the `kata-brainstorming` skill**, which lives in this repo at [`.claude/skills/kata-brainstorming/`](../../.claude/skills/kata-brainstorming). It is the print-mode-safe replacement for `superpowers:brainstorming`: it routes every clarifying question through the `ask_user` tool (a plain-text question in a headless run never reaches the operator — it just ends the run). Because the skill is discovered from the workspace's `.claude/skills/`, run this kata against a checkout of Kata, or install the skill into `~/.claude/skills/` to use it elsewhere.
- **Interactive runs** (`[interactive] enabled = true`) emit `ask.requested` events and pause for an answer; the Workbench shows an AskPanel, and a CLI driver answers over stdin. `answer_timeout_secs` bounds the wait (exit 123 if nobody answers).
- These are **starting points, not gospel** — adjust the model, leash, skills, and plugins to taste.

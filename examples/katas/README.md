# Example katas

Ready-to-use [run-specs](../../README.md). Each `.toml` is one kata: a precise, reproducible form for a single headless `claude -p` run. Copy them into your library or open them in the Workbench, fill in the task, and run. Two sets live here: the superpowers **brainstorm → plan → execute** trio, and the **kata plugin's** engineering-workflow kit (prd → context → plan → implement, plus triage).

## The trio

| Kata | Skill it drives | Deliverable | Interactive |
|------|-----------------|-------------|-------------|
| [`brainstorm-feature.toml`](brainstorm-feature.toml) | `kata-brainstorming` | a design doc under `docs/superpowers/specs/` | yes — asks via `ask_user` |
| [`write-plan.toml`](write-plan.toml) | `superpowers:writing-plans` | a reviewable implementation plan under `docs/` | no |
| [`execute-plan.toml`](execute-plan.toml) | `superpowers:subagent-driven-development` | the implemented change (TDD, in a worktree) | no |

They chain: brainstorm produces a spec, write-plan turns that spec into a plan, execute-plan works the plan step by step. Each tightens the leash to fit its job — brainstorm runs in-place with a modest turn cap, while execute-plan isolates in a git worktree, allows more turns, and sets a `max_budget_usd` ceiling.

## The kata plugin kit

Five katas driving the [`kata` plugin](../../.claude/plugins/kata/) — this repo's own engineering-workflow kit. Every skill asks only through `ask_user`, and routes mechanical work to Haiku subagents (`kata-scout`, `kata-test-runner`) while judgment work stays on Sonnet (the driver, `kata-implementer`, `kata-reviewer`).

| Kata | Skill it drives | Deliverable | Interactive |
|------|-----------------|-------------|-------------|
| [`prd.toml`](prd.toml) | `kata:prd` | a PRD under `docs/prds/` | yes — grills via `ask_user` |
| [`context.toml`](context.toml) | `kata:context` | a context pack under `docs/context/` | no |
| [`plan.toml`](plan.toml) | `kata:plan` | a TDD plan under `docs/plans/` | yes — approval gate |
| [`implement.toml`](implement.toml) | `kata:implement` | the implemented change (TDD, in a worktree) | no |
| [`triage.toml`](triage.toml) | `kata:triage` | a triage report under `docs/triage/` | yes — gaps + next-action confirm |

They chain: prd feeds context, context feeds plan, plan feeds implement — each run's output file is the next run's task input. triage stands alone and hands its "failing test to start from" to a plan/implement pair.

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
- **The kit katas use the `kata` plugin**, which lives in this repo at [`.claude/plugins/kata/`](../../.claude/plugins/kata/). Like the skill above, it is project-scoped: run these katas against a checkout of Kata, or copy the plugin to `~/.claude/plugins/kata/` to use it against any other repo.
- **Interactive runs** (`[interactive] enabled = true`) emit `ask.requested` events and pause for an answer; the Workbench shows an AskPanel, and a CLI driver answers over stdin. `answer_timeout_secs` bounds the wait (exit 123 if nobody answers).
- These are **starting points, not gospel** — adjust the model, leash, skills, and plugins to taste.

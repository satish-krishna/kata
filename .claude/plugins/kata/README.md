# kata (plugin)

The engineering-workflow kit for Kata runs: five skills that carry a change from rough idea to shipped code, plus issue triage — each one print-mode-safe (every question crosses Kata's `ask_user` bridge, never prose) and each one routing mechanical work to Haiku subagents while judgment stays on Sonnet.

## What's inside

| Skill | Command | Deliverable | Interactive? |
|-------|---------|-------------|--------------|
| `kata:prd` | `/kata:prd` | a PRD under `docs/prds/` | yes — grills via `ask_user` |
| `kata:context` | `/kata:context` | a context pack under `docs/context/` | rarely — one question at most |
| `kata:plan` | `/kata:plan` | a TDD plan under `docs/plans/` | yes — approval gate |
| `kata:implement` | `/kata:implement` | the implemented change, tree green | blockers only |
| `kata:triage` | `/kata:triage` | a triage report under `docs/triage/` | gaps + fix-approach confirm |

They chain: **prd → context → plan → implement**, each run's file feeding the next run's task. **triage** stands alone and hands its "failing test to start from" to a plan/implement pair.

## The model policy

Every skill routes work to the cheapest mind that can do it well, enforced structurally by the agents this plugin ships (model pinned in frontmatter):

| Agent | Model | Job |
|-------|-------|-----|
| `kata-scout` | **haiku** | read-only recon: structure, conventions, prior art, existence checks |
| `kata-test-runner` | **haiku** | run exactly the given commands, report verbatim |
| `kata-implementer` | **sonnet** | one plan step, strict TDD (red → minimal green → verify) |
| `kata-reviewer` | **sonnet** | skeptical review of one completed step, read-only |

The driver runs on Sonnet (pin `[model] id = "sonnet"` in the run-spec; the commands also pin `model: sonnet` in frontmatter) and never burns turns on file-tree tours or log-scrolling.

## The interaction contract

A Kata run drives `claude -p` headlessly — a question typed as prose ends the run unanswered. Every skill therefore asks **only** through the `ask_user` MCP tool Kata wires in when the run-spec sets `[interactive] enabled = true` (the built-in `AskUserQuestion` is disallowed by the engine). In non-interactive runs the skills degrade deliberately: conservative assumptions recorded in the deliverable, or a clean written stop at a blocker — never a stall.

**Where docs land is the operator's choice.** A path named in the task always wins; otherwise the doc-writing skills ask the destination through `ask_user` (leading with the defaults in the table above, or the repo's own convention); non-interactive runs take the default.

## Using it from a run-spec

This directory is embedded into the `kata` binary at build time and offered by the catalog as a **`builtin`** source (materialized on demand under `<kata-home>/builtin/`), so `[plugins.kata]` resolves against **any** workdir — no install step. A plugin named `kata` in `~/.claude/plugins/` or the target repo's `.claude/plugins/` shadows the builtin, which is also how you customize the kit. In the run-spec:

```toml
[plugins.kata]

[model]
id = "sonnet"

[interactive]
enabled = true            # for prd / plan / triage
answer_timeout_secs = 1800
```

Ready-made run-specs for all five skills live in [`examples/katas/`](../../../examples/katas/).

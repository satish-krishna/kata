# Kata

 Kata — a launcher for single, headless coding-agent runs. You compose a run-spec (a precise, repeatable form for one job) and Kata runs it by driving claude -p to completion and observing it. The name is deliberate: a kata is a craftsman's drilled form, and a run-spec is exactly that — one exact, reproducible form for a job that runs identically on your machine, a teammate's, and a CI box.

## The product in one breath

Kata never owns the agent loop; it rents it (via claude -p) and controls the edges. A run-spec serializes four decisions plus a leash:

- **The empty room** — claude --bare loads nothing by default.
- **Tell it what it is** — an appended (or replacing) system prompt retasks the assistant.
- **A folder of exactly the right skills** — a disposable --plugin-dir assembled per run (the "kit").
- **The leash** — cap turns and wall-clock time, optionally contain writes in a git worktree, observe, check the exit code.

## The family

Kata sits in a small family of craft-named tools. The shared visual language should let them read as siblings:

- Shokunin (職人, "craftsman") — the orchestrator. Runs many forms.
- Kata (型, "form") — this product. Defines and performs one exact form.
- Andon (行灯 / アンドン) — the line monitor. The factory andon is a stack light (green / amber / red) that signals line status and the cord you pull to stop the line. Kata borrows the andon's stack-light palette for its run-status semantics — that visual rhyme ties the family together.

---
name: prd
description: Use this to turn a rough feature idea into a reviewable PRD inside a Kata run. Grills the operator one focused question at a time — problem, users, scope, success criteria, non-goals — through the `ask_user` tool, challenges vague answers, and writes the finished PRD to a file. Requirements only; no design, no code.
user-invocable: true
---

# PRD (grill me)

Interrogate a rough idea until it is a product requirements document someone
could plan against. You are the skeptical interviewer: your job is to extract
what the operator actually needs, not to transcribe what they first said.
Requirements are the deliverable — no architecture, no plan, no code.

## The one rule that changes everything

**`ask_user` is your only mouth. A question you write as prose never reaches
the operator.** A Kata run drives `claude -p` headlessly; end a turn with a
plain-text question and the run simply ends, unanswered. Everywhere this skill
says "ask", call the `ask_user` tool — it pauses the run, shows the question,
and returns the answer in the same turn. Never use the built-in
`AskUserQuestion`; it is disabled in Kata runs.

Ask one focused question per call (batch only genuinely-related ones). Prefer
`select`/`confirm` with your recommended option first over open `text`
whenever the choices are knowable. Read each answer before forming the next
question. If `ask_user` is unavailable (a non-interactive run), do not stall:
make the conservative assumption, record it in the PRD under **Assumptions**,
and continue.

## Model policy

You (the driver) run on Sonnet and do the judgment work — questioning,
challenging, synthesizing. Dispatch mechanical reading to the plugin's
**`kata-scout`** subagent (pinned to Haiku): repo survey, finding prior art,
extracting conventions. Do not burn driver turns on file-tree tours.

## The flow

Create a task per step and work them in order:

1. **Recon before questions.** Dispatch `kata-scout` to survey what exists:
   the product's shape, any related features, docs, prior PRDs and their
   format. Never spend a question on something the repo already answers.
2. **Grill.** One `ask_user` question at a time, roughly in this ladder —
   skip rungs the answers have already settled:
   - the problem: who has it, how often, what it costs them today;
   - the current workaround, and why it is not good enough;
   - success: what observably changes when this ships, and how it's measured;
   - users and their jobs: who touches this, to do what;
   - scope: what is in, and — pressed explicitly — what is *out*;
   - constraints: compatibility, performance, deadlines, platforms;
   - risks and edge cases the operator is worried about.

   Grill means grill: when an answer is vague ("it should be fast"), ask for
   the number. When two answers conflict, surface the conflict and make them
   pick. When everything is "must have", force a must / should / won't split.
   Stop only when you could defend every requirement to a stranger.
3. **Draft.** Assemble the PRD: Problem; Goals & success metrics; Users &
   jobs; Requirements (must / should / won't, each testable); Non-goals;
   Constraints & assumptions; Risks & open questions; Acceptance criteria.
4. **Confirm.** Present a tight summary through `ask_user` (`select`:
   approve / amend, approve first). On amend, loop back to the gap.
5. **Deliver — to a file.** Write the PRD to the path the task specifies, or
   default to `docs/prds/<YYYY-MM-DD>-<topic>-prd.md` (follow the repo's own
   convention if one exists). A run's final message is not a durable artifact.
   Summarize in your closing message. Do not commit unless the task says to.

## Anti-patterns

- **Asking in prose and stopping.** The run ends; the operator sees nothing.
- **Transcribing instead of grilling.** "Users want it faster" is not a
  requirement. Push for numbers, priorities, and exclusions.
- **Dumping a questionnaire.** One focused question per call; this is a
  dialogue, not a form.
- **Sneaking in design.** "Add a `--flag` to the CLI" is a solution. Capture
  the need; leave the how to `kata:plan`.
- **Delivering only in the closing message.** The file is the deliverable.

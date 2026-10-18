# AskPanel on the spartan questionnaire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-built pending form in `AskPanel` with spartan's stepped questionnaire, and its answered view with a read-only summary, without changing the panel's inputs, outputs or the `ask.answered` answer shape.

**Architecture:** The question-to-model and model-to-answer logic moves into a pure module (`ask-form.ts`) so it is tested without a DOM. The settled view becomes its own presentational component (`AskSummary`). `AskPanel` keeps its selector, `ask` input and `answer` output; its pending branch renders the questionnaire over a Signal Form built from `ask-form.ts`. The vendored Helm questionnaire is then skinned to Kata, and the parity baselines are re-captured for the operator to approve.

**Tech Stack:** Angular 22 (signals, Signal Forms `@angular/forms/signals`), `@spartan-ng/brain` 1.8.0 questionnaire, vendored Helm under `app/libs/ui/questionnaire/`, Vitest via `ng test`, Playwright parity capture.

**Spec:** `docs/superpowers/specs/2026-10-18-ask-panel-questionnaire-design.md`

## Global Constraints

- `AskPanel` keeps selector `app-ask-panel`, `ask = input.required<AskRecord>()`, `answer = output<{ id: string; answers: string[][] }>()`. `ObservePane`, the run store and the transport do not change.
- Presentational components under `src/app/ui/` inject nothing; inputs and outputs only. Signal Forms only, submission through `submission.action`; no `FormsModule`, `ngModel`, `ngSubmit`.
- Compose every questionnaire part exactly as the spartan docs show it; appearance changes only in `app/libs/ui/questionnaire/` or through `variant`/`size`. No hex or raw `px` outside `libs/ui`.
- Required lives in the Signal Forms schema (`required()` on every non-optional key). Do not pass the `items` input to `form[hlmQuestionnaire]`.
- `shortcuts="numbers"`. Submit label exactly `Send answer · resume`. Free-text placeholder exactly `Other — type your own answer`; its `aria-label` exactly `Other answer`. Multi-select description exactly `choose any`. Summary empty texts exactly `(no answer)` and `(skipped)`. Banner texts exactly `awaiting your input` / `answered · run resumed`; footer hint exactly `the run is paused on the leash`.
- Kept by operator decision: Enter in a filled answer or Skip on the last step submits; a new pending ask takes focus.
- Tests locate questionnaire inputs by `aria-label`, `value` or `name`, never by `id` (brain overwrites ids).
- `PermissionPanel` shares `.k-ask`, `.k-ask__banner*`, `.k-ask__body`, `.k-ask__foot`, `.k-ask__hint`, `.k-ask__actions`, `.k-ask__confirm*`; those classes stay.
- Implementers: Sonnet for every task (each involves judgment on brain behavior); a stuck task escalates one tier.

## Review Focus

- A `select` question with no options (or an empty `options` array): only the free-text input renders; a required one cannot be submitted empty, and typed text is sent as `[text]`. Test in Task 3.
- Two pending asks on one page (a second `ask.requested` before the first settles is impossible, but a settled panel and a pending one coexist): answering the pending one must not touch the settled one, and two pending questionnaires must not share field names. Test in Task 3.
- A settled ask whose `answers` array is shorter than its questions, or has an empty entry: the summary shows `(no answer)` / `(skipped)` instead of throwing. Test in Task 2.
- An ask that arrives already settled (a replayed run): the summary renders and nothing takes focus. Test in Task 3.
- An option label with characters that break attribute selectors or HTML (`"`, `<`, `&`): the choice renders the label as text, and picking it sends the label exactly. Test in Task 3.

---

### Task 1: Pure question/answer mapping

**Files:**
- Create: `app/src/app/lib/ask-form.ts`
- Test: `app/src/app/lib/ask-form.spec.ts`

**Interfaces:**
- Consumes: `Question`, `QuestionOption` from `app/src/app/lib/events.ts`.
- Produces:
  - `type AskModel = Record<string, string | string[]>`
  - `fieldKey(i: number): string` returns `` `q${i}` ``
  - `isMulti(q: Question): boolean` (true only for `kind === 'select' && !!multi_select`)
  - `choicesOf(q: Question): QuestionOption[]`: `confirm` → `options ?? [{label:'Yes'},{label:'No'}]`; `select` → `options ?? []`; `text` → `[]`
  - `hasFreeText(q: Question): boolean` (`select` or `text`)
  - `emptyModel(questions: Question[]): AskModel` (`[]` for multi keys, `''` otherwise)
  - `toAnswers(questions: Question[], model: AskModel): string[][]`
  - `customAnswers(q: Question, answer: string[]): string[]` (answers not among `choicesOf(q)` labels)

- [ ] **Step 1: Write the failing tests** in `ask-form.spec.ts`:
  - `emptyModel` of `[text, single select, multi select, confirm]` equals `{ q0: '', q1: '', q2: [], q3: '' }`.
  - `choicesOf` of a confirm with no options equals `[{label:'Yes'},{label:'No'}]`; of a select with no options equals `[]`.
  - `toAnswers`: text `'hello'` → `['hello']`; text `''` → `['']`; single `'SQLite'` → `['SQLite']`; single `''` → `[]`; multi `['Redis','Kafka','Redis']` → `['Redis','Kafka']`; multi `[]` → `[]`.
  - `customAnswers(select with Postgres/SQLite, ['SQLite','DuckDB'])` equals `['DuckDB']`; for a text question it equals `[]`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx ng test --watch=false --include src/app/lib/ask-form.spec.ts`
Expected: FAIL, module `./ask-form` not found.

- [ ] **Step 3: Implement the functions above in `ask-form.ts`.** Plain functions, no Angular imports.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/lib/ask-form.ts app/src/app/lib/ask-form.spec.ts
git commit -m "feat(app): pure question-to-answer mapping for the ask panel"
```

### Task 2: AskSummary, the settled view

**Files:**
- Create: `app/src/app/ui/ask-summary.ts`
- Test: `app/src/app/ui/ask-summary.spec.ts`

**Interfaces:**
- Consumes: `Question` from `events.ts`; `choicesOf`, `customAnswers` from Task 1.
- Produces: `AskSummary`, selector `app-ask-summary`, inputs `questions = input.required<Question[]>()` and `answers = input.required<string[][]>()`. No outputs. Renders, per question, a `.k-ask__q` containing `.k-ask__q-eyebrow` (header), `.k-ask__q-text` (question) and the answer.

- [ ] **Step 1: Write the failing tests** in `ask-summary.spec.ts`:
  - `'shows a text answer'`: text question, answers `[['done']]` → a `.k-ask__answer` with text `done`.
  - `'shows (no answer) for an empty text answer'`: answers `[['']]` → `.k-ask__answer--empty` with text `(no answer)`.
  - `'lists listed choices and marks typed ones as Other'`: select Postgres/SQLite, multi, answers `[['SQLite','DuckDB']]` → text `SQLite` present; an element labelled `Other` followed by `DuckDB`; `Postgres` absent.
  - `'shows (skipped) for a select with no answer'`: answers `[[]]` → text `(skipped)`.
  - `'survives answers shorter than questions'`: two questions, answers `[['x']]` → renders both questions, the second shows `(no answer)` (text) or `(skipped)` (select); no throw.
  - `'renders no form controls'`: the container has no `input`, `button`, `textarea` or `form`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx ng test --watch=false --include src/app/ui/ask-summary.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `AskSummary`** with an inline template reusing the existing `.k-ask__q`, `.k-ask__q-head`, `.k-ask__q-eyebrow`, `.k-ask__q-text`, `.k-ask__answer`, `.k-ask__answer--empty`, `.k-ask__opt-label`, `.k-ask__other-answer` classes. Any new class it needs goes in `app/src/styles/kata/components.css` under the existing `.k-ask` block, token values only.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/ui/ask-summary.ts app/src/app/ui/ask-summary.spec.ts app/src/styles/kata/components.css
git commit -m "feat(app): read-only summary for a settled ask"
```

### Task 3: AskPanel on the questionnaire

**Files:**
- Modify: `app/src/app/ui/ask-panel.ts` (template and class rewritten)
- Rewrite: `app/src/app/ui/ask-panel.spec.ts`
- Delete: `app/src/app/ui/questionnaire-spike.spec.ts`

**Interfaces:**
- Consumes: Task 1's functions; Task 2's `AskSummary`; `HlmQuestionnaireImports` from `@spartan-ng/helm/questionnaire`; `form`, `FormField`, `FormRoot`, `required` from `@angular/forms/signals`.
- Produces: unchanged public surface (see Global Constraints).

Behavior to build (from the spec's "Question to item mapping", "Navigation" and "Answer mapping"):
- Settled (`ask().answers !== null`): banner `answered · run resumed` plus `<app-ask-summary>`; no form.
- Pending: banner `awaiting your input`, then `form[hlmQuestionnaire]` with `[formRoot]`, `shortcuts="numbers"`; `div[hlmQuestionnaireProgress]` only when there is more than one question; one `fieldset[hlmQuestionnaireItem]` per question with `[name]="fieldKey(i)"`, `[multiple]="isMulti(q)"`, `[formField]` bound to that key; inside it the eyebrow and question in `legend[hlmQuestionnaireTitle]`, `p[hlmQuestionnaireDescription]` `choose any` for multi, `div[hlmQuestionnaireChoices]` with a `label[hlmQuestionnaireChoice]` per `choicesOf(q)` (label text and `hlmQuestionnaireChoiceDescription`) and, when `hasFreeText(q)`, one `input[hlmQuestionnaireInput]` (select: `aria-label="Other answer"`, placeholder `Other — type your own answer`; text: `aria-label` = question text, placeholder = `q.placeholder ?? ''`); then `p[hlmQuestionnaireError]`. Then the `.k-ask__foot` with the hint and `div[hlmQuestionnaireActions]` holding Previous, Skip, Next, and Submit labelled `Send answer · resume`.
- The Signal Form is built once per ask from `emptyModel(ask().questions)`, with `required()` on each key whose question is not optional, and `submission.action` emitting `{ id, answers: toAnswers(questions, model) }`. If a runtime-keyed model cannot be expressed with `form()`, stop and report rather than bypass Signal Forms.
- Single-select: when a listed choice becomes checked (`checkedChange`), clear that question's free-text input value so the operator never sees text that will not be sent.

- [ ] **Step 1: Rewrite `ask-panel.spec.ts`** keeping its `mount()` helper shape, locating inputs by `aria-label`/`value`. Tests:
  - Carried over: `'offers a free-text answer on every select question'`; `'does not offer free text on a confirm question'`; `'an empty free-text answer never sends'` (type `'   '`, press Send, `answer` not emitted, `[hlmQuestionnaireError]` text visible); `'single-select: typed text replaces the choice'` (pick SQLite, type DuckDB, send → `[['DuckDB']]`); `'single-select: picking a listed choice after typing clears the text'` (type DuckDB, pick SQLite → input value `''`; send → `[['SQLite']]`); `'multi-select: typed text joins the ticked options'` (→ `[['Postgres','DuckDB']]`); `'multi-select: a ticked label typed again is sent once'` (→ `[['Postgres']]`); `'sends typed text for a text question'`; `'confirm defaults to Yes/No'` (pick No → `[['No']]`); `'settled: shows the answered banner and the summary, no form'`.
  - New: `'shows one question at a time'` (two questions: second fieldset `hidden`); `'Next moves to the next question; Send appears on the last'`; `'a required question refuses Next until answered'` (click Next unanswered → still on question 1, error text shown); `'an optional question can be skipped'` (two questions, first optional: Skip, answer second, send → `[[], ['…']]` for a select first question); `'Skip on the last optional question sends'` (single optional select: Skip → emits `[[]]`); `'Enter in a filled answer on the last step sends'`; `'a number key picks a choice'` (press `2` on the active item → second choice checked); `'a pending ask takes focus'` (`document.activeElement` is inside the form after mount); `'an already-settled ask takes no focus'` (`document.activeElement` is `document.body`).
  - Review Focus: `'a select with no options offers only free text'` (options `undefined` → no `label[hlmQuestionnaireChoice]`, one input; send empty refused; typed `x` → `[['x']]`); `'labels with quotes and markup are sent exactly'` (option `He said "<b>&"` renders as text and picking it sends that exact string); `'two panels do not share fields'` (mount a settled and a pending panel in one host; answering the pending one emits from it only and the settled summary is unchanged; the two forms' fieldset `name` attributes differ).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd app && npx ng test --watch=false --include src/app/ui/ask-panel.spec.ts`
Expected: FAIL (old template has no `form[hlmQuestionnaire]`).

- [ ] **Step 3: Rewrite `AskPanel`** per "Behavior to build". Remove the per-index `selected`/`text`/`otherOn`/`otherText` signals, the autofocus effect and `viewChildren`. Delete `questionnaire-spike.spec.ts`.

- [ ] **Step 4: Run the panel tests, then the whole unit suite and lint**

Run: `cd app && npx ng test --watch=false --include src/app/ui/ask-panel.spec.ts && npm test -- --watch=false && npm run lint && npm run check:wiring`
Expected: all PASS; `observe-pane.spec.ts` still passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A app/src/app/ui/ask-panel.ts app/src/app/ui/ask-panel.spec.ts app/src/app/ui/questionnaire-spike.spec.ts
git commit -m "feat(app): AskPanel steps through questions on the spartan questionnaire"
```

### Task 4: Kata skin for the questionnaire

**Files:**
- Modify: `app/libs/ui/questionnaire/src/lib/hlm-questionnaire-choice.ts`, `hlm-questionnaire-input.ts`, `hlm-questionnaire-title.ts`, `hlm-questionnaire-description.ts`, `hlm-questionnaire-choice-description.ts`, `hlm-questionnaire-error.ts`, `hlm-questionnaire-progress.ts`, `hlm-questionnaire-actions.ts`, `hlm-questionnaire-choices.ts`, `hlm-questionnaire-item.ts` (only those whose look differs from the target)
- Modify: `app/src/styles/kata/components.css` (remove `.k-ask__opt*`, `.k-ask__mark*`, `.k-ask__opts` if no longer referenced anywhere; keep every class `PermissionPanel` or `AskSummary` uses)

**Interfaces:**
- Consumes: Task 3's rendered markup.
- Produces: no API change.

Target look, from the current `.k-ask__opt` rules in `components.css` (lines 199–213 before this task): choice row on `--surface-inset`, 1px `--border-default`, `--radius-sm`, padding `--space-3` × `--space-4`, `--border-strong` + `--surface-hover` on hover, `--accent` border + `--accent-subtle` background when checked; 16px mark with `--border-strong`, filled `--accent` with `--text-on-accent` dot or check when checked; label `--weight-medium` `--text-base` `--text-primary`; description `--text-xs` `--text-muted`. Free-text input matches `.k-input`. Error text uses `--error-text`, `--text-xs`. Use Tailwind arbitrary values over Kata tokens, as `libs/ui/button/src/lib/hlm-button.ts` does.

- [ ] **Step 1: Capture the current look for comparison**

Run: `cd app && npm run check:parity -- --only observe-ask`
Expected: FAIL with a diff image in `app/parity/diff/observe-ask.png` (the Task 3 markup is unskinned). Keep `app/parity/actual/observe-ask.png` open beside `app/parity/baseline/observe-ask.png`.

- [ ] **Step 2: Edit the vendored class strings** to the target look.

- [ ] **Step 3: Re-capture and compare**

Run: `cd app && npm run check:parity -- --only observe-ask`
Expected: the diff shrinks to layout differences the stepped design introduces (progress, step buttons, inline free-text input); the choice rows match the baseline's rows in color, border and type.

- [ ] **Step 4: Remove dead `.k-ask__*` rules**

Run: `cd app && grep -rn "k-ask__opt\|k-ask__mark\|k-ask__opts" src` before deleting each rule; delete only rules with no remaining reference. Then `npx stylelint "src/**/*.css" && npm run build`.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/libs/ui/questionnaire app/src/styles/kata/components.css
git commit -m "style(app): Kata skin for the questionnaire"
```

### Task 5: Parity capture and new baselines

**Files:**
- Modify: `app/parity/capture.mjs` (`answerAsk`)
- Modify: `app/parity/baseline/observe-ask.png`, `observe-permission.png`, `observe-complete.png`, `observe-toolcards-open.png` (only after operator approval)

**Interfaces:**
- Consumes: Task 3 markup (`label[hlmQuestionnaireChoice]`, `button[hlmQuestionnaireNext]`, Submit `Send answer · resume`).

- [ ] **Step 1: Rewrite `answerAsk(page)`** to drive the questionnaire: for each step, fill the visible text input if the active item has no choices, otherwise click its first visible `label[hlmQuestionnaireChoice]`; then click Next if visible, else `getByRole('button', { name: 'Send answer · resume' })`.

- [ ] **Step 2: Run the full parity check**

Run: `cd app && npm run check:parity`
Expected: every non-observe view `ok`; the four observe views differ, with images in `app/parity/actual/`.

- [ ] **Step 3: Stop and show the operator** the four `app/parity/actual/observe-*.png` images beside their baselines. Do not continue without explicit approval.

- [ ] **Step 4: On approval, bless and re-check**

Run: `cd app && cp parity/actual/observe-ask.png parity/actual/observe-permission.png parity/actual/observe-complete.png parity/actual/observe-toolcards-open.png parity/baseline/ && npm run check:parity`
Expected: `parity: all views match`.

- [ ] **Step 5: Run every gate**

Run: `cd app && npm run lint && npx stylelint "src/**/*.css" && npm test -- --watch=false && npm run build && npm run check:wiring && npm run check:boot && npm run check:interaction && npm run check:responsive && npm run check:parity && npm run test:harness`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/parity
git commit -m "test(app): parity drives the stepped questionnaire; new observe baselines"
```

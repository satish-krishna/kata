# Spartan 1.8 Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Workbench's hand-rolled tool-card shell, confirm dialog, stream tailing, banner, empty state, toaster, code bodies and turn rule with the installed spartan 1.8 Helm primitives, skinned so the Kata look holds.

**Architecture:** Each swap edits one presentational component in `app/src/app/ui/` (or the shell), skins the matching Helm copy in `app/libs/ui/<family>/` against Kata tokens, and proves itself with a unit test that crosses the template seam. Parity screenshots are the visual acceptance test, re-blessed only for the spec's listed deviations.

**Tech Stack:** Angular 22 (signals, OnPush default), spartan brain/helm 1.8.0, Tailwind 4, Vitest via `ng test`, Testing Library, Playwright parity harness.

**Spec:** `docs/superpowers/specs/2026-10-18-spartan-adoption-design.md`

## Global Constraints

- Style only against Kata CSS custom properties; never a hex value (`npx stylelint "src/**/*.css"`).
- The Kata look lives in the `libs/ui/` copy or `src/styles/kata/`; never appearance classes at the call site (`no-appearance-on-primitive`).
- `src/app/ui/` components inject nothing: inputs and outputs only.
- Andon: status color always paired with a dot and a visible label; never the accent for status.
- No new npm dependency. Do not edit `app/harness/gate/rules/primitive-vocabulary.ts`, `app/harness/gate/rules/no-raw-control.ts`, `app/eslint.config.mjs`, `app/stylelint.config.mjs` (owner-protected; the vocabulary is already widened).
- US English, sentence-case labels, no emoji. Markdown has no hard wraps.
- All commands run from `app/`. Per-task gate before commit: `npm run lint`, `npx stylelint "src/**/*.css"`, `npm test -- --watch=false`. Commit messages end with the session's attribution lines.

## Review Focus

1. A ToolCard that goes running → error after first render must still open itself (the `toggled` null policy) once the shell is a brain collapsible. Pinned in Task 2.
2. A reader scrolled up must not be pulled to the bottom when an ask/permission pause or a new event arrives. Pinned in Task 4.
3. Escape and Cancel on the discard confirm must emit `cancel`, and Discard must emit `confirm`, after the move to alert-dialog. Pinned in Task 3.
4. A toast raised before `<hlm-toaster>` renders, or two errors in quick succession, must both show. Pinned in Task 6.
5. A closed ToolCard must expose no focusable body content (inert) and no diff DOM. Pinned in Task 2.

---

### Task 1: Gate learns alert-dialog composition

**Files:**
- Modify: `app/harness/gate/rules/no-missing-composition-part.ts` (`REQUIRED_DESCENDANT`), `app/harness/gate/rules/no-unportalled-overlay.ts` (its container table), `app/harness/counter/counter.mjs` (its composition table near `'hlm-dialog-content': 'hlmDialogTitle'`)
- Modify: `app/harness/rules/no-missing-composition-part.md`, `app/harness/rules/no-unportalled-overlay.md` (add the alert-dialog row to whatever table/list names dialog and sheet)
- Test: the existing gate and counter test files that hold the dialog fixtures (find them with `grep -rln "hlm-dialog-content" harness`)

**Interfaces:**
- Produces: `'hlm-alert-dialog-content': 'hlmAlertDialogTitle'` in both composition tables; `'hlm-alert-dialog': ['hlm-alert-dialog-content', 'hlmAlertDialogPortal']` in the overlay table.

- [ ] **Step 1:** Next to each existing dialog fixture, add an alert-dialog twin: a good template (`<hlm-alert-dialog><hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx"><h2 hlmAlertDialogTitle>x</h2></hlm-alert-dialog-content></hlm-alert-dialog>`) expecting no report, and bad ones (content without `hlmAlertDialogTitle` → `missingCompositionPart` / counter kind `missing-composition-part`; content not under `hlmAlertDialogPortal` → the overlay rule's messageId). Update any `toEqual` totals blocks the counter tests use.
- [ ] **Step 2:** `npm run test:harness`. Expect the new bad cases to FAIL (no report yet).
- [ ] **Step 3:** Add the table entries in gate and counter, and the doc rows.
- [ ] **Step 4:** `npm run test:harness`. Expect all to pass.
- [ ] **Step 5:** Commit `feat(gate): alert-dialog needs its title and its portal`.

### Task 2: ToolCard shell on trace

**Files:**
- Modify: `app/libs/ui/trace/src/lib/hlm-trace-line.ts` (status type adds `'ok'`), other trace copies as the skin needs; `app/src/app/ui/tool-card.ts`; Kata CSS for `.k-toolcard*` in `app/src/styles/kata/components.css` only where the new structure needs it
- Test: `app/src/app/ui/tool-card.spec.ts`

**Interfaces:**
- Consumes: `HlmTraceImports` from `@spartan-ng/helm/trace`; `CallStatus`, `STATUS_TEXT`, `defaultOpen` from `lib/toolcards.ts` (unchanged).
- Produces: `ToolCard` keeps its single input `call: ToolCall` and selector `app-tool-card`.

- [ ] **Step 1: Write failing tests** in `tool-card.spec.ts` (existing tests must keep passing; adjust only selectors that name the old row element, never weaken an assertion):
  - `the row is a collapsible trigger wired to its body`: the row button has `aria-controls` equal to the id of the body element, and `aria-expanded` flips `false`→`true` on click.
  - `a closed card renders no body content and its body is inert`: for a collapsed Read, no `.k-toolcard__out` in the DOM and the content element has the `inert` attribute.
  - `a call that turns to error after render opens itself`: render a running Read (use only), then set the `call` input to the same call with a failed result; the body is now open (Review Focus 1). Then click once and assert it closes, proving the operator's click still wins.
  - `the status label is visible beside the dot` for ok, error and running (`ok`, `error`, `running…`).
- [ ] **Step 2:** `npm test -- --watch=false --include src/app/ui/tool-card.spec.ts`. Expect the new tests to FAIL.
- [ ] **Step 3:** Rebuild the template per spec §1: `hlm-trace-collapsible [expanded]="open()" (expandedChange)="toggled.set($event)"`, `button hlmTraceCollapsibleTrigger` holding `hlm-trace-line [status]="status()"`, chevron and dot in `hlm-trace-icon`, name and target in `hlm-trace-title`, meta and status label in `hlm-trace-description`, body in `hlm-trace-collapsible-content` with its content still behind `@if (open())`. Skin the trace copies so the row matches today's `.k-toolcard__row`. Respect `motion-reduce` on the height transition.
- [ ] **Step 4:** Run the spec, then the full per-task gate. All pass.
- [ ] **Step 5:** Commit `feat(app): tool cards are spartan trace collapsibles`.

### Task 3: ConfirmDialog on alert-dialog

**Files:**
- Modify: `app/src/app/ui/confirm-dialog.ts`; `app/libs/ui/alert-dialog/src/lib/*` (Kata skin matching today's `.k-dialog` look)
- Test: `app/src/app/ui/confirm-dialog.spec.ts`

**Interfaces:**
- Produces: unchanged API: inputs `open: boolean`, `message: string`, `confirmLabel: string`; outputs `confirm`, `cancel`. `workbench.html` is untouched.

- [ ] **Step 1: Failing tests:** the rendered dialog has `role="alertdialog"` and an accessible name equal to `message`; clicking Cancel emits `cancel`; clicking the confirm button emits `confirm`; closing via the brain state change (the path Escape takes) emits `cancel` (Review Focus 3). If jsdom cannot drive the CDK overlay, as `app/CLAUDE.md` warns, test through the existing `onState` seam and leave the overlay behavior to `npm run check:interaction`.
- [ ] **Step 2:** Run the spec. Expect FAIL.
- [ ] **Step 3:** Implement per spec §2 with `hlmAlertDialogTitle`, `hlmAlertDialogCancel`, `hlmAlertDialogAction`, portalled content (it must satisfy Task 1's rules).
- [ ] **Step 4:** Per-task gate plus `npm run build && npm run check:interaction`. All pass.
- [ ] **Step 5:** Commit `feat(app): the discard confirm is an alert dialog`.

### Task 4: Stream tailing on message-scroller

**Files:**
- Modify: `app/src/app/ui/observe-pane.ts`; `app/libs/ui/message-scroller/src/lib/*` (skin); `app/src/styles/kata/workbench.css` if `.wb-stream` layout must move onto the viewport
- Delete: `app/src/app/lib/scroll.ts`, `app/src/app/lib/scroll.spec.ts` (only if `grep -rn isAtBottom src` shows no other user)
- Test: `app/src/app/ui/observe-pane.spec.ts`

**Interfaces:**
- Produces: `ObservePane` inputs and outputs unchanged; `trackKey` stays the item key and becomes each item's `messageId`.

- [ ] **Step 1: Failing tests:** the stream is a scroll region named `Event stream`; each stream item carries its `trackKey` as its message id; with the viewport scrolled up (set `scrollTop` and dispatch `scroll`, mocking geometry on the viewport element), appending an event and then an ask pause does not change `scrollTop` (Review Focus 2); a `Scroll to latest event` button exists. Delete any test that asserts on the removed `stick`/`onScroll` internals only if an equivalent behavior test replaces it.
- [ ] **Step 2:** Run the spec. Expect FAIL.
- [ ] **Step 3:** Implement per spec §3 (`hlmMessageScrollerProvider [autoScroll]="true"`, viewport, content, one item per stream item, `button hlmMessageScrollerButton aria-label="Scroll to latest event"`). Remove `stick`, `onScroll`, the `afterRenderEffect`, and `streamEl` if unused.
- [ ] **Step 4:** Per-task gate plus `npm run build && npm run check:boot && npm run check:responsive`. All pass.
- [ ] **Step 5:** Commit `feat(app): the event stream tails through spartan's message scroller`.

### Task 5: ValidationBanner on alert, stream empty state on empty

**Files:**
- Modify: `app/src/app/ui/validation-banner.ts`, `app/src/app/ui/observe-pane.ts` (empty branch only); skins in `app/libs/ui/alert/`, `app/libs/ui/empty/`
- Test: `app/src/app/ui/validation-banner.spec.ts`, `app/src/app/ui/observe-pane.spec.ts`

- [ ] **Step 1: Failing tests:** the banner renders an `hlm-alert` with `role="alert"` listing every error, and renders nothing for `[]`; the empty observe pane renders `hlm-empty` with the existing copy `Press Run to drive claude -p to completion. The normalized event stream renders here.` (assert on text content).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement per spec §4 (first two bullets). Skin to today's `.wb-banner--error` and `.wb-stream__empty` look.
- [ ] **Step 4:** Per-task gate. All pass.
- [ ] **Step 5:** Commit `feat(app): validation banner and empty stream use alert and empty`.

### Task 6: Toasts on sonner

**Files:**
- Modify: `app/src/app/core/toast/toast.store.ts`, `toast.store.spec.ts`, `app/src/app/app.ts`, `app/src/app/app-shell.view-model.ts` (and its spec if any), `app/libs/ui/sonner/src/lib/hlm-toaster.ts` (Kata skin)
- Delete: `app/src/app/ui/toaster.ts`, `app/src/app/ui/toaster.spec.ts`

**Interfaces:**
- Produces: `ToastStore.error(message: string): string | number` (whatever brain's `toast.error` returns). Every existing caller of `error` compiles unchanged.

- [ ] **Step 1: Failing tests:** `ToastStore.error` delegates to brain `toast.error` with the message and `duration: 6000` (spy on the imported `toast`); rendering the app shell after two `error` calls shows both messages in the `hlm-toaster` region (Review Focus 4); each toast has a dismiss control with an accessible name.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement per spec §4 (third bullet). Remove the signal list, the timers and `dismiss` from `ToastStore`, and the toast members from `AppShellViewModel`.
- [ ] **Step 4:** Per-task gate plus `npm run check:wiring && npm run build && npm run check:boot`. All pass.
- [ ] **Step 5:** Commit `feat(app): toasts are spartan sonner`.

### Task 7: Output, JSON and diff bodies on code-block

**Files:**
- Modify: `app/src/app/ui/output-body.ts`, `json-body.ts`, `diff-body.ts`; skin in `app/libs/ui/code-block/`
- Test: `app/src/app/ui/diff-body.spec.ts`, `tool-card.spec.ts`

- [ ] **Step 1: Failing tests:** an output body renders `pre[hlmCodeBlockContent]` with the text, `(no output)` for empty, and the `… truncated at 256 KB` note in the code-block footer when truncated; a diff renders one `span[hlmCodeBlockLine]` per line with `data-variant`/variant class `added` for adds and `removed` for deletes, each keeping its `+`/`−` mark. Update the Task 2 spec selectors that named `.k-toolcard__dl--add/--del` or `.k-toolcard__out` to the new structure without weakening them.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement per spec §5. No copy button.
- [ ] **Step 4:** Per-task gate. All pass.
- [ ] **Step 5:** Commit `feat(app): tool bodies render in spartan code blocks`.

### Task 8: Turn rows on marker

**Files:**
- Modify: `app/src/app/ui/event-row.ts` (turn case); skin in `app/libs/ui/marker/`; remove `.k-event__turn-rule` CSS if nothing uses it
- Test: `app/src/app/ui/event-row.spec.ts`

- [ ] **Step 1: Failing test:** a `turn` event with `n: 3` renders `hlm-marker` with the separator variant and text `turn 3`; non-turn rows render no marker.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement per spec §6.
- [ ] **Step 4:** Per-task gate. All pass.
- [ ] **Step 5:** Commit `feat(app): turn separators are spartan markers`.

### Task 9: Parity and the full board

**Files:**
- Modify: `app/parity/capture.mjs` only if a capture must wait out a transition; `app/parity/baseline/*.png` only for the spec's deliberate deviations

- [ ] **Step 1:** Run the full board: `npm run lint`, `npx stylelint "src/**/*.css"`, `npm test -- --watch=false`, `npm run build`, `npm run check:wiring`, `npm run check:boot`, `npm run check:interaction`, `npm run check:responsive`, `npm run test:harness`, `npm run check:parity`.
- [ ] **Step 2:** For each parity diff, either fix the skin until it matches, or confirm it is one of the spec's listed deviations. Save the diff images for the report.
- [ ] **Step 3:** Re-bless only the deviating views (the harness's bless path), rerun `npm run check:parity` to green.
- [ ] **Step 4:** Commit `test(app): parity baselines for the adopted primitives`, listing each re-blessed view and why in the body.

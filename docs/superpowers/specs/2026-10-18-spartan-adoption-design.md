# Adopt spartan 1.8 primitives across the Workbench

## Intent

The Workbench hand-rolls several things spartan 1.8 now ships as Helm primitives. The owner's rule (2026-10-18): adopt wherever a spartan equivalent exists (consistency), ordered so the swaps that add accessibility or behavior we lack land first. One branch, one PR.

The Kata look does not change because the primitive changed. Each adopted Helm copy in `app/libs/ui/` is skinned to reproduce today's Kata classes, so the parity baseline is the acceptance test: a view that diffs is either fixed or listed below as a deliberate deviation and re-blessed on purpose.

## Already done on the branch

- The eight families are installed as stock Helm copies: `trace`, `code-block`, `alert-dialog`, `alert`, `empty`, `sonner`, `message-scroller`, `marker` (commit 809ec37). Generated button variants were mapped onto Kata's button (33a3fc7).
- The gate vocabulary is widened to exactly their selectors, owner-authorized, mirrored in the counter and `harness/sealing-spec.md` (4db8d23).

## The swaps, in order

### 1. ToolCard header and nesting → `trace` (accessibility, behavior)

`app/src/app/ui/tool-card.ts` keeps its per-tool bodies and `lib/toolcards.ts` logic. Only the shell changes:

- The card is an `hlm-trace-collapsible` bound `[expanded]="open()"` and `(expandedChange)` writing `toggled`. The existing policy stays: `toggled` is null until the operator clicks, so `defaultOpen` still decides, and a call that fails after it rendered still opens itself.
- The row is `button[hlmTraceCollapsibleTrigger]` holding an `hlm-trace-line`. Brain then supplies `aria-expanded` and `aria-controls` (today we hand-set `aria-expanded` and have no `aria-controls`). The chevron and status dot sit in `hlm-trace-icon`, the tool name and target in `hlm-trace-title`, the `+add −del`/meta text and the status label in `hlm-trace-description`.
- The body is `hlm-trace-collapsible-content`. Brain marks it `inert` while closed. The body content stays behind `@if (open())`, so a closed card renders no diff or output DOM, as today.
- `HlmTraceLine.status` in the Kata copy gains `'ok'`, so the type is `'ok' | 'running' | 'error' | 'pending'`, matching `CallStatus` (`ok | error | running`). Andon rule: status is never color alone. The `STATUS_TEXT` label stays visible in the row.
- Agent children render as today (nested `app-tool-card` / `app-event-row`) inside the content.
- The height transition respects `motion-reduce`. Parity captures must not catch a mid-transition frame: the capture waits for the transition to finish, or the Kata skin drops the transition. The builder's call, stated in the PR.

### 2. ConfirmDialog → `alert-dialog` (semantics)

`app/src/app/ui/confirm-dialog.ts` keeps its inputs and outputs (`open`, `message`, `confirmLabel`, `confirm`, `cancel`) and moves to `hlm-alert-dialog` with `hlmAlertDialogTitle` for the message, `hlmAlertDialogCancel` (Kata ghost) and `hlmAlertDialogAction` (Kata primary). The result is `role="alertdialog"`, and a click outside no longer discards. Escape still cancels.

The gate learns the alert-dialog's composition, in both engines (gate rules are not owner-protected): `no-missing-composition-part` requires `hlmAlertDialogTitle` inside `hlm-alert-dialog-content`; `no-unportalled-overlay` requires `hlm-alert-dialog` to compose `hlm-alert-dialog-content` under `hlmAlertDialogPortal`. Each rule gets a good and a bad fixture, as the existing dialog entries have.

### 3. Stream scrolling → `message-scroller` (behavior)

`app/src/app/ui/observe-pane.ts` replaces its hand-rolled tailing (the `stick` flag, `onScroll`, the `afterRenderEffect`, and `lib/scroll.ts`'s `isAtBottom`) with `hlmMessageScrollerProvider [autoScroll]="true"`, an `hlm-message-scroller-viewport` (`aria-label="Event stream"`) and one `hlm-message-scroller-item [messageId]="trackKey(item)"` per stream item, inside `hlm-message-scroller-content`. The behavior that must survive is the one the old comment names: follow the tail only while the reader is at the bottom, and never pull a reader who scrolled up back down, including when an ask or permission pause arrives. An `button[hlmMessageScrollerButton]` (`aria-label="Scroll to latest event"`) appears when the reader is away from the end. That control is new and deliberate.

`lib/scroll.ts` and its spec are deleted if nothing else imports `isAtBottom`. The keyed `trackKey` and the `wb-event-enter` fade stay.

### 4. ValidationBanner → `alert`, stream empty state → `empty`, Toaster → `sonner` (consistency)

- `validation-banner.ts`: `hlm-alert` (destructive variant, skinned to the current `.wb-banner--error` look), icon, and an `hlmAlertDescription` holding the error list. `role="alert"` stays.
- Observe empty state: `hlm-empty` > `hlm-empty-header` > `hlm-empty-media` (the terminal icon) and `hlmEmptyDescription` (the existing copy, verbatim).
- Toasts: `<hlm-toaster>` replaces `<app-toaster>` in `app.ts`. `ToastStore.error(message)` keeps its signature and calls brain's `toast.error(message, …)` with the current 6000 ms lifetime, with dismissal handled by sonner. The `toasts` signal, `dismiss`, the timer map, `AppShellViewModel`'s toast members, `ui/toaster.ts` and its spec go away (`check:wiring` must stay green). The Kata skin keeps the andon pairing: an error toast shows the crimson dot and the message, a dismiss control with an accessible name, and a floating shadow (toasts float). It is dark-only.

### 5. Output, JSON and diff bodies → `code-block` (consistency)

- `output-body.ts`, `json-body.ts`: `hlm-code-block size="sm"` with `pre hlmCodeBlockContent`. Keep the `(no output)` fallback and the `… truncated at 256 KB` note, the latter in `hlm-code-block-footer`.
- `diff-body.ts`: `pre hlmCodeBlockContent` projecting one `span hlmCodeBlockLine` per line with `variant` `added` / `removed` / `default` from the line kind, keeping the `+`/`−` mark. The before/after fallback branch uses `app-output-body`, as today.
- No copy button in this pass: it is a new visible control and not asked for. It is a follow-up.

### 6. Turn rows → `marker` (consistency)

`event-row.ts`'s `turn` case renders `hlm-marker variant="separator"` carrying `turn N`, replacing `.k-event__turn-rule`. The other event rows keep their gutter grid. `marker` is a flex row and would break the gutter alignment the stream depends on, so it is used for the separator only.

## Constraints

- Style only against Kata tokens. No hex values. The Kata look goes in the `libs/ui/` copy or in `src/styles/kata/`, never at the call site (`no-appearance-on-primitive`).
- `src/app/ui/` components inject nothing.
- No new npm dependency (brain's sonner is self-contained).
- US English, sentence-case labels, no emoji.
- Every gate stays green: lint, stylelint, unit tests, build, `check:wiring`, `check:boot`, `check:interaction`, `check:responsive`, `test:harness`, `check:parity`.

## Deliberate visible deviations (re-bless these, nothing else)

- The scroll-to-latest button, wherever a parity view leaves the stream scrolled away from the end.
- The turn separator's look (text centered between two rules) in the observe views.
- Any ToolCard row pixel change that the trace structure forces and the skin cannot absorb. Each one is named in the PR.

## Not in scope

- A copy button on code blocks.
- `marker` for non-turn rows.
- Narrowing `no-restated-validator`, the `app/CLAUDE.md` "injects nothing" wording, and `optionalMessage` on optional text questions. These are carried over from #47.
- A version bump. The owner said none.

## Left to the builder

The exact Kata skin classes per Helm copy, how the parity capture avoids transition frames, and whether `json-body` shares `output-body`'s template.

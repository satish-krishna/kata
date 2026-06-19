# Replace native prompt/alert/confirm with design-system UI — design

A Phase-4 follow-up flagged in the PR #16 review: the Workbench still uses browser-native `alert()`, `prompt()`, and `confirm()` in a few places. These are off-brand against the dark "sumi-ink" design system and inconsistent with the in-app `TaskEditor`/`AskPanel` modals. This replaces all three with design-system UI.

## Problem

Eight native-dialog call sites remain (`app/src`):
- **`alert()` ×6** — error feedback: `routes/library/+page.svelte` (load kata ×2, export bundle); `routes/+page.svelte` (load spec, save kata, export bundle, save preset).
- **`prompt()` ×1** — `components/ComposePane.svelte`, "Preset name?" when saving the current context as a preset.
- **`confirm()` ×1** — `routes/+page.svelte` `confirmDiscard()`, "Discard unsaved changes?", gating New/Open when the spec is dirty.

Native dialogs use the OS chrome, break the visual language, and (for `alert`/`prompt`) block the event loop. The design system already sanctions toasts and has a reusable `.k-dialog` (scrim + card + actions, introduced with `TaskEditor`).

## Goals

- Errors → **toasts** (floating, andon-error, auto-dismissing, manually closable).
- The preset-name prompt → a **`PromptDialog`** (single-line input modal).
- The discard guard → a **`ConfirmDialog`** (message + Confirm/Cancel).
- Zero native `alert`/`prompt`/`confirm` left in `app/src`.
- Reuse existing tokens and `.k-dialog`; the only new CSS is `.k-toast*`.

## Non-goals

- Toast variants beyond error (no success/info toasts until a caller needs one — YAGNI).
- Touching `AskPanel` (the interactive ask UI is a separate concern, already on-brand).
- Any Rust / contract / `RunSpec` / `KataEvent` change — this is purely `app/src`.
- A generic modal abstraction. `PromptDialog`/`ConfirmDialog`/`TaskEditor` each use the `.k-dialog` classes directly, matching the established pattern; no shared `Dialog` primitive is introduced.

## Components

### Toast store — `app/src/lib/toast.svelte.ts`

A module-level reactive store (Svelte 5 runes in a `.svelte.ts` file):

```ts
export type Toast = { id: number; kind: "error"; message: string };
// internal: `let items = $state<Toast[]>([])`, a monotonic `let seq = 0` for ids,
// and a per-toast setTimeout (~6000ms) that calls dismiss(id).
export function toasts(): Toast[];          // reactive read for the Toaster
export function toastError(message: string): number;  // push; returns id
export function dismiss(id: number): void;  // remove (also clears its timer)
```

Ids are a monotonic counter (no `Math.random`). The auto-dismiss timer is created on push and cleared on `dismiss` (and when it fires). `kind` is `"error"` only for now (the type leaves room without adding unused UI).

### `Toaster.svelte` — `app/src/lib/components/Toaster.svelte`

Renders the toast stack, mounted once in the root layout. Floating container fixed to the **bottom-right** (newest on top, stacking upward; unless `design/` specifies otherwise), each toast an andon-error card: `--error`/`--error-border`/`--error-subtle`/`--error-text` for the dot+text, `--surface-card` body, `--shadow-lg` (floating), a status dot + the message + a close button (`@lucide/svelte/icons/x`). No hard-coded colours. `role="alert"` for a11y.

Mounted in `app/src/routes/+layout.svelte` once (it overlays both routes).

### `.k-toast*` CSS — `app/src/styles/components/components.css`

New classes using only existing tokens: a fixed-position `.k-toaster` stack (gap via `--space-*`), `.k-toast` card (surface-card + `--shadow-lg` + tight radius + hairline border), `.k-toast--error` (the andon-error accenting: a left/dot accent in `--error`, text in `--error-text`/`--text-primary`), `.k-toast__close` icon button. Mirror the existing `.k-ask` / `.k-dialog` token usage. No hex/rgb literals.

### `PromptDialog.svelte` — `app/src/lib/components/PromptDialog.svelte`

A single-line input modal reusing `.k-dialog` (like `TaskEditor`):

```ts
let { title, initial = "", placeholder = "", onConfirm, onCancel }:
  { title: string; initial?: string; placeholder?: string; onConfirm: (value: string) => void; onCancel: () => void } = $props();
```

A `.k-dialog__head` (title), a single-line `<input class="k-input">` bound to a local `draft` initialized from `initial`, and `.k-dialog__actions` with Cancel + a primary Confirm. Confirm is **disabled when `draft.trim()` is empty**; Enter (in the input) confirms a non-empty draft, Esc cancels. `onConfirm(draft.trim())`.

### `ConfirmDialog.svelte` — `app/src/lib/components/ConfirmDialog.svelte`

A message + two-button modal reusing `.k-dialog`:

```ts
let { message, confirmLabel = "Confirm", onConfirm, onCancel }:
  { message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void } = $props();
```

`.k-dialog__head`/body shows `message`; `.k-dialog__actions` has Cancel (ghost) + a primary button labelled `confirmLabel`. Esc cancels. No text input.

## Call-site changes

### Errors → toasts
Replace each `alert(\`Failed to …: ${e}\`)` with `toastError(\`Failed to …: ${e}\`)` (import `toastError` from `$lib/toast.svelte`):
- `routes/library/+page.svelte`: `onReRun`, `onOpenInCompose`, `onExportBundle` catch blocks.
- `routes/+page.svelte`: `onOpen` (load spec), `onSave` (save kata), `onExport` (export bundle), `onSavePreset` (save preset) catch blocks.

### Preset name → `PromptDialog`
`ComposePane.svelte` `onSaveAsPreset`: instead of `const name = prompt("Preset name?")`, set a local `naming = true` state; render `{#if naming}<PromptDialog title="Save as preset" placeholder="Preset name" onConfirm={(name) => { naming = false; onSavePreset(name, spec.context ?? ""); }} onCancel={() => (naming = false)} />{/if}`. The empty-name guard now lives in the dialog (Confirm disabled when blank), so `onSaveAsPreset` only opens the dialog (still gated on a non-empty context as today).

### Discard guard → `ConfirmDialog`
`routes/+page.svelte`: replace the synchronous `confirmDiscard()` with a deferred flow.

```ts
let confirmDiscardState = $state<{ action: () => void | Promise<void> } | null>(null);

function guardDiscard(action: () => void | Promise<void>) {
  if (!dirty) { void action(); return; }       // clean → run immediately
  confirmDiscardState = { action };            // dirty → ask first
}
```

`onNew` and `onOpen` route their bodies through `guardDiscard(...)` (the open body stays async). Render once:

```svelte
{#if confirmDiscardState}
  <ConfirmDialog message="Discard unsaved changes?" confirmLabel="Discard"
    onConfirm={() => { const a = confirmDiscardState.action; confirmDiscardState = null; void a(); }}
    onCancel={() => (confirmDiscardState = null)} />
{/if}
```

The old `confirmDiscard()` function is removed.

## Testing

- **`toast.svelte.ts`** (vitest, fake timers): `toastError` pushes a toast and returns a unique id; `dismiss(id)` removes it and clears its timer; auto-dismiss fires after the timeout and removes it; two pushes get distinct ids; `dismiss` of an unknown id is a no-op.
- **`guardDiscard`** decision — extract the dirty-vs-run decision as a tiny pure/unit-testable helper (or test it via a thin wrapper): not-dirty → action runs immediately and no dialog state is set; dirty → action deferred and dialog state set. Keep it minimal; the dialog rendering itself is presentational.
- **Dialogs + Toaster** are presentational (logic-light, mount-gated like `TaskEditor`); covered by `npm run check` + `npm run build`, no component-render tests (matches the existing test style).
- `npm run check` (0 errors; the pre-existing AskPanel + TaskEditor `state_referenced_locally` warnings remain), `npm test`, `npm run build` all green.

## File structure

- Create: `app/src/lib/toast.svelte.ts`, `app/src/lib/components/Toaster.svelte`, `app/src/lib/components/PromptDialog.svelte`, `app/src/lib/components/ConfirmDialog.svelte`, `app/src/lib/toast.test.ts`.
- Modify: `app/src/styles/components/components.css` (`.k-toast*`), `app/src/routes/+layout.svelte` (mount `Toaster`), `app/src/routes/+page.svelte` (toasts + ConfirmDialog flow), `app/src/routes/library/+page.svelte` (toasts), `app/src/lib/components/ComposePane.svelte` (PromptDialog).

## Sequencing

A small `app/src`-only follow-up on `feat/design-system-dialogs` off `main`. TDD where there's logic (the toast store, the guard decision); the rest is presentational wiring verified by check/build. clippy is irrelevant (no Rust change); `npm run check`/`npm test`/`npm run build` green; review before merge. Independent of the remaining Phase 4 cycles (guard-hooks, MCP config).

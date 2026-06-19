# Design-system Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Workbench's browser-native `alert()`/`prompt()`/`confirm()` with design-system UI — toasts for errors, a `PromptDialog` for the preset name, a `ConfirmDialog` for the discard guard.

**Architecture:** A small reactive toast store + a `Toaster` mounted once in the root layout (errors); two presentational modals reusing the existing `.k-dialog` classes (prompt + confirm). All eight native call sites are swapped. `app/src`-only — no Rust/contract change.

**Tech Stack:** SvelteKit + TypeScript (Svelte 5 runes), the existing Kata "sumi-ink" design tokens.

## Global Constraints

- Branch `feat/design-system-dialogs` (off `main`, already created). `app/src`-only; no Rust/contract/binding change (clippy/cargo not involved).
- Style ONLY against existing CSS custom properties; NO hard-coded hex/rgb. The only new CSS is `.k-toast*`; mirror the existing `.k-ask` (andon) and `.k-dialog` token usage.
- Reuse the existing `.k-dialog` (`__scrim`/`__head`/`__actions`) classes and `.k-input`/`.k-btn`/`.k-textarea` primitives — do NOT add a generic modal abstraction; each dialog uses `.k-dialog` directly (matching `TaskEditor.svelte`).
- Toast ids are a monotonic counter (no `Math.random`). Auto-dismiss ~6000ms, also manually closable.
- Zero native `alert`/`prompt`/`confirm` left in `app/src` at the end.
- Verify with `npm --prefix app run check` (0 errors; the pre-existing AskPanel + TaskEditor `state_referenced_locally` warnings remain), `npm --prefix app test`, `npm --prefix app run build` — all green.
- Frequent commits, one per task.

---

### Task 1: Toast store + Toaster + mount

**Files:**
- Create: `app/src/lib/toast.svelte.ts`
- Create: `app/src/lib/components/Toaster.svelte`
- Create: `app/src/lib/toast.test.ts`
- Modify: `app/src/styles/components/components.css` (`.k-toast*`)
- Modify: `app/src/routes/+layout.svelte` (mount `Toaster`)

**Interfaces:**
- Produces: `$lib/toast` exports `type Toast = { id: number; kind: "error"; message: string }`, `toasts(): Toast[]`, `toastError(message: string): number`, `dismiss(id: number): void`. Task 2 calls `toastError`.

- [ ] **Step 1: Write the failing store test**

Create `app/src/lib/toast.test.ts` (the project already unit-tests `.svelte.ts` rune stores — see `run.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toasts, toastError, dismiss } from "./toast";

describe("toast store", () => {
  beforeEach(() => {
    // clear any leftover toasts between tests
    for (const t of [...toasts()]) dismiss(t.id);
  });

  it("toastError pushes an error toast and returns a unique id", () => {
    const a = toastError("boom one");
    const b = toastError("boom two");
    expect(a).not.toBe(b);
    expect(toasts().map((t) => t.message)).toEqual(["boom one", "boom two"]);
    expect(toasts()[0].kind).toBe("error");
  });

  it("dismiss removes a toast by id; unknown id is a no-op", () => {
    const id = toastError("x");
    dismiss(-999); // no-op
    expect(toasts().length).toBe(1);
    dismiss(id);
    expect(toasts().length).toBe(0);
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    try {
      toastError("temp");
      expect(toasts().length).toBe(1);
      vi.advanceTimersByTime(6000);
      expect(toasts().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix app test -- toast.test 2>&1 | tail -15`
Expected: FAIL — `./toast` not found.

- [ ] **Step 3: Implement `toast.svelte.ts`**

```ts
/** Transient error notifications, rendered by Toaster (mounted in the root
 *  layout). Replaces native alert(). */
export type Toast = { id: number; kind: "error"; message: string };

const TTL_MS = 6000;
let items = $state<Toast[]>([]);
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Reactive read of the current toasts (newest last). */
export function toasts(): Toast[] {
  return items;
}

/** Push an error toast; returns its id. Auto-dismisses after TTL_MS. */
export function toastError(message: string): number {
  const id = ++seq;
  items.push({ id, kind: "error", message });
  timers.set(id, setTimeout(() => dismiss(id), TTL_MS));
  return id;
}

/** Remove a toast (and clear its timer). Unknown id is a no-op. */
export function dismiss(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  items = items.filter((x) => x.id !== id);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix app test -- toast.test 2>&1 | tail -15`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `.k-toast*` CSS**

In `app/src/styles/components/components.css`, append (mirror the existing `.k-ask` andon-token usage; **verify the exact error-variant token names against `app/src/styles/tokens/colors.css`** — by symmetry with the warning set used in `.k-ask` they are `--error`, `--error-border`, `--error-subtle`, `--error-text`; if a name differs, use the actual one). NO hex/rgb literals:

```css
/* toasts — transient error notifications (floating, bottom-right) */
.k-toaster {
  position: fixed; right: var(--space-5); bottom: var(--space-5); z-index: 200;
  display: flex; flex-direction: column-reverse; gap: var(--space-2);
  max-width: 380px;
}
.k-toast {
  display: flex; align-items: center; gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-card); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
  color: var(--text-primary); font: var(--weight-medium) var(--text-sm)/1.4 var(--font-sans);
}
.k-toast--error { border-color: var(--error-border); }
.k-toast__dot {
  width: 8px; height: 8px; border-radius: var(--radius-full);
  background: var(--error); flex: none;
}
.k-toast__msg { flex: 1; }
.k-toast__close {
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; color: var(--text-faint); cursor: pointer;
  padding: var(--space-1); border-radius: var(--radius-sm);
}
.k-toast__close:hover { color: var(--text-secondary); }
```

(If a referenced spacing/radius/font token name differs in `tokens/`, substitute the real one — match what `.k-ask` and `.k-dialog` use.)

- [ ] **Step 6: Implement `Toaster.svelte`**

```svelte
<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { toasts, dismiss } from "$lib/toast";
</script>

{#if toasts().length > 0}
  <div class="k-toaster">
    {#each toasts() as t (t.id)}
      <div class="k-toast k-toast--{t.kind}" role="alert">
        <span class="k-toast__dot"></span>
        <span class="k-toast__msg">{t.message}</span>
        <button class="k-toast__close" aria-label="Dismiss" onclick={() => dismiss(t.id)}><X size={14} /></button>
      </div>
    {/each}
  </div>
{/if}
```

- [ ] **Step 7: Mount in the root layout**

Edit `app/src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import "../styles/styles.css";
  import "../styles/workbench.css";
  import Toaster from "$lib/components/Toaster.svelte";
  let { children } = $props();
</script>

{@render children()}
<Toaster />
```

- [ ] **Step 8: Verify + commit**

Run: `npm --prefix app test 2>&1 | tail -4` (toast tests pass, rest green)
Run: `npm --prefix app run check 2>&1 | tail -4` (no new errors)
Run: `npm --prefix app run build 2>&1 | tail -3` (succeeds)

```bash
git add app/src/lib/toast.svelte.ts app/src/lib/toast.test.ts app/src/lib/components/Toaster.svelte app/src/styles/components/components.css app/src/routes/+layout.svelte
git commit -m "feat(web): toast store + Toaster (andon-error, auto-dismiss) in root layout"
```

---

### Task 2: Errors → toasts (swap the 6 `alert()` sites)

**Files:**
- Modify: `app/src/routes/+page.svelte` (4 `alert` sites)
- Modify: `app/src/routes/library/+page.svelte` (3 `alert` sites)

**Interfaces:**
- Consumes: `toastError` from `$lib/toast` (Task 1).

- [ ] **Step 1: Swap the compose-route alerts**

In `app/src/routes/+page.svelte`, add `import { toastError } from "$lib/toast";` (with the other `$lib` imports) and replace each error `alert(...)`:

- `onOpen` catch: `alert(\`Failed to load spec: ${e}\`)` → `toastError(\`Failed to load spec: ${e}\`)`
- `onSave` catch: `alert(\`Failed to save kata: ${e}\`)` → `toastError(\`Failed to save kata: ${e}\`)`
- `onExport` catch: `alert(\`Failed to export bundle: ${e}\`)` → `toastError(\`Failed to export bundle: ${e}\`)`
- `onSavePreset` catch: `alert(\`Failed to save preset: ${e}\`)` → `toastError(\`Failed to save preset: ${e}\`)`

- [ ] **Step 2: Swap the library-route alerts**

In `app/src/routes/library/+page.svelte`, add `import { toastError } from "$lib/toast";` and replace:

- `onReRun` catch: `alert(\`Failed to load kata: ${e}\`)` → `toastError(\`Failed to load kata: ${e}\`)`
- `onOpenInCompose` catch: `alert(\`Failed to load kata: ${e}\`)` → `toastError(\`Failed to load kata: ${e}\`)`
- `onExportBundle` catch: `alert(\`Failed to export bundle: ${e}\`)` → `toastError(\`Failed to export bundle: ${e}\`)`

- [ ] **Step 3: Verify no `alert(` remains + green**

Run: `cd app && rg -n "alert\(" src; cd ..` (or `grep -rn "alert(" app/src`) — Expected: no matches in `.svelte`/`.ts` source (the only `alert` reference left should be none; the `role="alert"` attribute is unrelated and fine).
Run: `npm --prefix app run check 2>&1 | tail -4` (no new errors)
Run: `npm --prefix app test 2>&1 | tail -4` (green)
Run: `npm --prefix app run build 2>&1 | tail -3` (succeeds)

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/+page.svelte app/src/routes/library/+page.svelte
git commit -m "feat(web): error feedback via toasts (replace alert)"
```

---

### Task 3: `PromptDialog` + preset-name wiring

**Files:**
- Create: `app/src/lib/components/PromptDialog.svelte`
- Modify: `app/src/lib/components/ComposePane.svelte` (replace `prompt()`)

**Interfaces:**
- Produces: `PromptDialog` props `{ title: string; initial?: string; placeholder?: string; onConfirm: (value: string) => void; onCancel: () => void }`.

- [ ] **Step 1: Implement `PromptDialog.svelte`**

Mirror `TaskEditor.svelte`'s `.k-dialog` structure with a single-line input:

```svelte
<script lang="ts">
  let { title, initial = "", placeholder = "", onConfirm, onCancel }:
    { title: string; initial?: string; placeholder?: string; onConfirm: (value: string) => void; onCancel: () => void } = $props();
  let draft = $state(initial);
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && draft.trim()) onConfirm(draft.trim());
  }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={key}>
  <div class="k-dialog__head">{title}</div>
  <input class="k-input" {placeholder} bind:value={draft} aria-label={title} />
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={() => onConfirm(draft.trim())} disabled={!draft.trim()}>Save</button>
  </div>
</div>
```

- [ ] **Step 2: Wire it into ComposePane**

In `app/src/lib/components/ComposePane.svelte`:
- Add `import PromptDialog from "./PromptDialog.svelte";` with the other component imports.
- Add state: `let naming = $state(false);`
- Replace `onSaveAsPreset` (which used `prompt`):

```ts
  function onSaveAsPreset() {
    if ((spec.context ?? "").trim() === "") return;
    naming = true;
  }
```

- At the end of the component markup (after the last `</section>`, so it overlays as a fixed modal), render:

```svelte
{#if naming}
  <PromptDialog
    title="Save as preset"
    placeholder="Preset name"
    onConfirm={(name) => { naming = false; onSavePreset(name, spec.context ?? ""); }}
    onCancel={() => (naming = false)}
  />
{/if}
```

(The empty-name guard now lives in the dialog — Save is disabled while the input is blank — so `onSaveAsPreset` only opens it, still gated on a non-empty context.)

- [ ] **Step 3: Verify no `prompt(` remains + green**

Run: `grep -rn "prompt(" app/src` — Expected: no matches.
Run: `npm --prefix app run check 2>&1 | tail -4` (no new errors)
Run: `npm --prefix app test 2>&1 | tail -4` (green)
Run: `npm --prefix app run build 2>&1 | tail -3` (succeeds)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/components/PromptDialog.svelte app/src/lib/components/ComposePane.svelte
git commit -m "feat(web): PromptDialog for preset naming (replace prompt)"
```

---

### Task 4: `ConfirmDialog` + discard-guard wiring

**Files:**
- Create: `app/src/lib/components/ConfirmDialog.svelte`
- Modify: `app/src/routes/+page.svelte` (replace `confirm()` with the deferred guard flow)

**Interfaces:**
- Produces: `ConfirmDialog` props `{ message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }`.

- [ ] **Step 1: Implement `ConfirmDialog.svelte`**

```svelte
<script lang="ts">
  let { message, confirmLabel = "Confirm", onConfirm, onCancel }:
    { message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void } = $props();
  function key(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label={message} tabindex="-1" onkeydown={key}>
  <div class="k-dialog__head">{message}</div>
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={onConfirm}>{confirmLabel}</button>
  </div>
</div>
```

- [ ] **Step 2: Replace the discard guard in the compose route**

In `app/src/routes/+page.svelte`:
- Add `import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";` with the other component imports.
- Remove the `confirmDiscard()` function. Add the deferred guard + state (place near the other handlers):

```ts
  let confirmDiscardState = $state<{ action: () => void | Promise<void> } | null>(null);

  // Run `action` immediately when there are no unsaved changes; otherwise defer
  // it behind a confirm dialog.
  function guardDiscard(action: () => void | Promise<void>) {
    if (!dirty) { void action(); return; }
    confirmDiscardState = { action };
  }
```

- Rewrite `onNew` and `onOpen` to route through it:

```ts
  function onNew() {
    guardDiscard(() => {
      spec = defaultSpec();
      saved = $state.snapshot(spec) as RunSpec;
      currentPath = null;
    });
  }

  function onOpen() {
    guardDiscard(async () => {
      const path = await api.pickOpenSpec();
      if (!path) return;
      try {
        const loaded = await api.loadSpec(path);
        spec = draftFrom(loaded);
        saved = $state.snapshot(spec) as RunSpec;
        currentPath = path;
      } catch (e) {
        toastError(`Failed to load spec: ${e}`);
      }
    });
  }
```

(`onOpen` is no longer `async` at the top level — the async work moved inside the guarded action. `toastError` is already imported from Task 2.)

- Render the dialog once (near the other top-level modal markup / end of the template):

```svelte
{#if confirmDiscardState}
  <ConfirmDialog
    message="Discard unsaved changes?"
    confirmLabel="Discard"
    onConfirm={() => { const a = confirmDiscardState.action; confirmDiscardState = null; void a(); }}
    onCancel={() => (confirmDiscardState = null)}
  />
{/if}
```

- [ ] **Step 3: Verify no `confirm(` remains + green**

Run: `grep -rn "confirm(" app/src/routes app/src/lib` — Expected: no native `confirm(` call (the only matches should be `confirmLabel`/`confirmDiscardState`/`onConfirm` identifiers and the CSS comment, not a `confirm(...)` invocation).
Run: `npm --prefix app run check 2>&1 | tail -4` (no new errors)
Run: `npm --prefix app test 2>&1 | tail -4` (green)
Run: `npm --prefix app run build 2>&1 | tail -3` (succeeds)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/components/ConfirmDialog.svelte app/src/routes/+page.svelte
git commit -m "feat(web): ConfirmDialog for the discard guard (replace confirm)"
```

---

### Final verification (before PR)

- [ ] `grep -rn "\b\(alert\|prompt\|confirm\)(" app/src` — no native calls remain (only `role="alert"`, `confirmLabel`, identifiers).
- [ ] `npm --prefix app run check` — 0 errors (the 2 pre-existing AskPanel + TaskEditor warnings remain).
- [ ] `npm --prefix app test` — green (incl. the toast store tests).
- [ ] `npm --prefix app run build` — succeeds.
- [ ] `git diff --stat main` — only the files named across Tasks 1–4 changed.
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch to open the PR.

## Notes for the implementer

- **No Rust in this branch** — `cargo`/clippy are not involved; verification is `npm run check`/`test`/`build`.
- **Reuse, don't abstract.** `PromptDialog`/`ConfirmDialog` use the `.k-dialog` classes directly, exactly like `TaskEditor.svelte`. Do not introduce a shared modal primitive.
- **The discard guard is presentational wiring** (a `dirty`-vs-defer branch); it is verified by check/build, consistent with how `TaskEditor`/the other dialogs are handled (no component-render tests in this codebase). The real unit-test weight is on the toast store (Task 1).
- **Tokens only.** The single new CSS block (`.k-toast*`) must reference existing custom properties — verify error-variant token names against `tokens/colors.css` and mirror `.k-ask`.
- A `state_referenced_locally` warning on `draft = $state(initial)` in PromptDialog is expected and benign (same as TaskEditor) — the dialog is mount-gated (`{#if}`), so the prop is read once on a fresh mount.

# Workbench Permission Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workbench's `[permissions] mode = "prompt"` surfaces reachable, self-healing, and covered by tests, so the approval card actually runs before release.

**Architecture:** Four independent changes to the SvelteKit frontend, all presentational or fixture-level — no engine change. The compose pane gains two spec-mutating handlers (clear rules on a flip to `bypass`; an inline warning that enables interactive). `validateLocal` gains a faithful port of the engine's three permission coherence checks. The browser mock's run timeline grows from two segments to three so a `permission.requested` pause exists to render. Tests come first for each.

**Tech Stack:** Svelte 5 (runes), SvelteKit static SPA, TypeScript, Vitest + `@testing-library/svelte`, jsdom.

**Reference spec:** `docs/superpowers/specs/2026-08-08-workbench-permission-prompts-design.md`

---

## Background the engineer needs

**Run this before anything else** (from `app/`): `npm ci`. Tests are `npm test` (it now runs `svelte-kit sync` itself). A single file: `npx vitest run src/lib/components/PermissionPanel.test.ts`.

**How the permission feature works.** A run-spec has a `permissions` block: `mode` (`"bypass"` | `"prompt"`), `allow`/`deny` (string rule arrays), and `unmatched` (`"ask"` | `"deny"` | `"allow"`). Under `prompt`, the engine answers each of claude's permission checks itself and emits two events:

- `permission.decided` — emitted for **every** check. Fields: `id`, `tool`, `input_summary`, `allow`, `decided_by`, `message?`. `decided_by` is one of `allow-rule`, `deny-rule`, `unmatched-policy`, `operator`.
- `permission.requested` — emitted **only** when a check pauses the run on the operator (`unmatched = "ask"`). Fields: `id`, `tool`, `input_summary`.

The run store (`src/lib/run.svelte.ts:53-73`) turns a `permission.requested` into a `PermissionRecord` card and flips state to `awaiting`; a `permission.decided` that matches an open card resolves it, and one that doesn't lands in the event stream as an audit row. **That store logic already works and is already tested** in `src/lib/run.test.ts:153-239` — do not rewrite it.

**Engine validation rules being mirrored** (`crates/kata-core/src/spec.rs:477-512`) — the wording must match:

1. Under `bypass` with any allow/deny rule: `permissions.allow/deny are only consulted under permissions.mode = "prompt"; under "bypass" claude never asks, so the rules would be ignored`
2. Under `prompt` with `unmatched = "ask"` and interactive off: `permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, or choose unmatched = "deny" / "allow" for a headless run`
3. Any malformed rule: `<field> has a malformed rule '<raw>'; expected 'Tool' or 'Tool(specifier)'`

**Rule grammar** (`crates/kata-core/src/permission.rs:31-60`) — trim first; empty is malformed; with no `(`, a stray `)` is malformed; with a `(`, the string must end in `)` and the text before `(` must be non-empty.

**Design rules are non-negotiable** — read `app/CLAUDE.md`. Style only against CSS custom properties, never a hex literal. A status colour always carries a dot or icon **and** a label.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/src/lib/components/PermissionPanel.test.ts` | Create | Cover the approval card's pending and settled states |
| `app/src/lib/mock.test.ts` | Create | Cover `validateLocal`'s permission mirror |
| `app/src/lib/mock.ts` | Modify | Add the 3 validation rules; 3-segment timeline; coherent `seedSpec` |
| `app/src/lib/api.ts` | Modify | Generalize the mock resume; stop fabricating the decided event |
| `app/src/lib/components/ComposePane.svelte` | Modify | Clear stale rules; inline interactive warning |
| `app/src/lib/components/ComposePane.test.ts` | Modify | Cover both compose behaviors |
| `app/src/styles/workbench.css` | Modify | One `.wb-banner--warning` variant |

---

## Task 1: Cover the approval card

**Files:**
- Create: `app/src/lib/components/PermissionPanel.test.ts`
- Read for reference: `app/src/lib/components/PermissionPanel.svelte`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/components/PermissionPanel.test.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PermissionPanel from "./PermissionPanel.svelte";

const PENDING = {
  id: "p1",
  tool: "Bash",
  input_summary: "rm -rf build/",
};

describe("PermissionPanel — pending", () => {
  it("shows the tool, the input, and both verdict buttons", () => {
    render(PermissionPanel, { ...PENDING, onDecide: vi.fn() });
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allow · resume" })).toBeEnabled();
  });

  it("sends (id, true, null) on allow", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    await fireEvent.click(screen.getByRole("button", { name: "Allow · resume" }));
    expect(onDecide).toHaveBeenCalledWith("p1", true, null);
  });

  it("sends the trimmed reason on deny", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    const reason = screen.getByRole("textbox");
    await fireEvent.input(reason, { target: { value: "  not on main  " } });
    await fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("p1", false, "not on main");
  });

  it("sends null rather than an empty reason on deny", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "   " } });
    await fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("p1", false, null);
  });

  it("renders an empty-input placeholder when there is no input summary", () => {
    render(PermissionPanel, { ...PENDING, input_summary: "", onDecide: vi.fn() });
    expect(screen.getByText("(no input)")).toBeInTheDocument();
  });
});

describe("PermissionPanel — settled", () => {
  it("marks the taken verdict, disables both buttons, and drops the textarea", () => {
    render(PermissionPanel, { ...PENDING, decided: { allow: true, message: null } });
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(allow).toBeDisabled();
    expect(deny).toBeDisabled();
    expect(allow).toHaveClass("k-ask__confirm-btn--selected");
    expect(deny).not.toHaveClass("k-ask__confirm-btn--selected");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders the denial message and marks deny as taken", () => {
    render(PermissionPanel, {
      ...PENDING,
      decided: { allow: false, message: "not on this branch" },
    });
    expect(screen.getByText("not on this branch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveClass("k-ask__confirm-btn--selected");
  });

  it("labels the settled state as resumed", () => {
    render(PermissionPanel, { ...PENDING, decided: { allow: true, message: null } });
    expect(screen.getByText("allowed · run resumed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests**

Run from `app/`: `npx vitest run src/lib/components/PermissionPanel.test.ts`

Expected: **all pass**. This task is characterization — the component already exists and these assertions lock its contract in before Tasks 3-5 change the code around it. If any assertion fails, the component has a real bug: fix `PermissionPanel.svelte`, not the test, and note it in the commit.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/components/PermissionPanel.test.ts
git commit -m "test(workbench): cover the permission approval card"
```

---

## Task 2: Mirror the engine's permission validation in the browser

**Files:**
- Create: `app/src/lib/mock.test.ts`
- Modify: `app/src/lib/mock.ts:83-91` (`validateLocal`)

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/mock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateLocal } from "./mock";
import { defaultSpec } from "./spec";

/** A spec that passes every non-permission check, so only permission errors surface. */
function runnableSpec() {
  const s = defaultSpec();
  s.name = "demo";
  s.task = "do the thing";
  s.workdir = "D:/Repos/acme-api";
  return s;
}

describe("validateLocal — permission coherence", () => {
  it("accepts the default bypass posture with no rules", () => {
    expect(validateLocal(runnableSpec())).toEqual([]);
  });

  it("rejects rules carried under bypass mode", () => {
    const s = runnableSpec();
    s.permissions.allow = ["Read"];
    expect(validateLocal(s)).toContain(
      'permissions.allow/deny are only consulted under permissions.mode = "prompt"; under "bypass" claude never asks, so the rules would be ignored',
    );
  });

  it("rejects unmatched = ask when interactive is off", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    expect(validateLocal(s)).toContain(
      'permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, or choose unmatched = "deny" / "allow" for a headless run',
    );
  });

  it("accepts unmatched = ask once interactive is on", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.interactive.enabled = true;
    expect(validateLocal(s)).toEqual([]);
  });

  it("accepts a headless prompt run with unmatched = deny", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.allow = ["Read", "Bash(git *)", "*"];
    expect(validateLocal(s)).toEqual([]);
  });

  it.each([
    ["Bash(unclosed", "permissions.allow"],
    ["", "permissions.allow"],
    ["   ", "permissions.allow"],
    ["Bash)", "permissions.allow"],
    ["(specifier)", "permissions.allow"],
  ])("rejects the malformed rule %j", (rule, field) => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.allow = [rule];
    expect(validateLocal(s)).toContain(
      `${field} has a malformed rule '${rule}'; expected 'Tool' or 'Tool(specifier)'`,
    );
  });

  it("reports a malformed deny rule against the deny field", () => {
    const s = runnableSpec();
    s.permissions.mode = "prompt";
    s.permissions.unmatched = "deny";
    s.permissions.deny = ["Bash(unclosed"];
    expect(validateLocal(s)).toContain(
      "permissions.deny has a malformed rule 'Bash(unclosed'; expected 'Tool' or 'Tool(specifier)'",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `app/`: `npx vitest run src/lib/mock.test.ts`

Expected: FAIL — the four rejection tests fail because `validateLocal` returns `[]`. The three acceptance tests pass already.

- [ ] **Step 3: Implement the mirror**

In `app/src/lib/mock.ts`, replace the whole `validateLocal` function (currently lines 83-91) with:

```ts
/** Faithful port of `kata-core::permission::parse_rule` — a rule is `Tool` or
 *  `Tool(specifier)`. Empty is malformed; a stray `)` without a `(` is
 *  malformed; a `(` must close at the end and be preceded by a tool name. */
function ruleIsWellFormed(raw: string): boolean {
  const r = raw.trim();
  if (r === "") return false;
  const open = r.indexOf("(");
  if (open === -1) return !r.includes(")");
  if (!r.endsWith(")")) return false;
  return r.slice(0, open).trim() !== "";
}

/** Client-side mirror of `kata-core::spec::validate` (see lib.rs validate_spec).
 *  Under Tauri the real engine validates; this keeps browser review honest, so
 *  it must never be more optimistic than the engine. */
export function validateLocal(spec: RunSpec): string[] {
  const errs: string[] = [];
  if (spec.schema !== 1) errs.push(`unsupported schema version ${spec.schema} (expected 1)`);
  if (!spec.name || !spec.name.trim()) errs.push("name is required");
  if (!spec.task || !spec.task.trim()) errs.push("task is required");
  if (!spec.workdir || !spec.workdir.trim()) errs.push("workdir is required");
  if (spec.leash.max_turns != null && spec.leash.max_turns < 1) errs.push("leash.max_turns must be >= 1");

  // Permissions — a setting that would be silently ignored is an error, so a
  // spec never looks like it constrains a run when it does not.
  const p = spec.permissions;
  if (p.mode === "bypass") {
    if (p.allow.length > 0 || p.deny.length > 0) {
      errs.push(
        'permissions.allow/deny are only consulted under permissions.mode = "prompt"; ' +
          'under "bypass" claude never asks, so the rules would be ignored',
      );
    }
  } else if (p.unmatched === "ask" && !spec.interactive.enabled) {
    errs.push(
      'permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, ' +
        'or choose unmatched = "deny" / "allow" for a headless run',
    );
  }
  for (const [field, rules] of [
    ["permissions.allow", p.allow],
    ["permissions.deny", p.deny],
  ] as const) {
    for (const raw of rules) {
      if (!ruleIsWellFormed(raw)) {
        errs.push(`${field} has a malformed rule '${raw}'; expected 'Tool' or 'Tool(specifier)'`);
      }
    }
  }
  return errs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `app/`: `npx vitest run src/lib/mock.test.ts`
Expected: PASS, 11 tests.

Then run the whole suite to confirm nothing regressed: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/mock.ts app/src/lib/mock.test.ts
git commit -m "fix(workbench): mirror the engine's permission checks in browser validation"
```

---

## Task 3: Clear stale rules when the mode flips back to bypass

**Files:**
- Modify: `app/src/lib/components/ComposePane.test.ts`
- Modify: `app/src/lib/components/ComposePane.svelte:99-105` (helpers) and `:281-286` (mode control)

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/components/ComposePane.test.ts`:

```ts
import type { RunSpec } from "../../bindings/RunSpec";

/** Render the pane over a caller-owned spec so tests can assert the mutations
 *  the pane makes. The pane mutates the object it is handed. */
function renderSpec(mutate: (s: RunSpec) => void = () => {}) {
  const spec = defaultSpec();
  mutate(spec);
  render(ComposePane, {
    spec,
    entries: [],
    onPickWorkdir: vi.fn(),
    presets: [],
    onSavePreset: vi.fn(),
  });
  return spec;
}

const ALLOW_PLACEHOLDER = "Read\nGrep\nBash(git *)";

describe("ComposePane permissions — rule visibility", () => {
  it("hides the rule editors under bypass", () => {
    renderSpec();
    expect(screen.queryByPlaceholderText(ALLOW_PLACEHOLDER)).toBeNull();
  });

  it("shows the rule editors under prompt", async () => {
    renderSpec();
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(screen.getByPlaceholderText(ALLOW_PLACEHOLDER)).toBeInTheDocument();
  });

  it("drops blank lines when parsing rules", async () => {
    const spec = renderSpec((s) => (s.permissions.mode = "prompt"));
    const allow = screen.getByPlaceholderText(ALLOW_PLACEHOLDER);
    await fireEvent.input(allow, { target: { value: "Read\n\n  Grep  \n" } });
    expect(spec.permissions.allow).toEqual(["Read", "Grep"]);
  });

  it("clears entered rules when the mode flips back to bypass", async () => {
    const spec = renderSpec((s) => {
      s.permissions.mode = "prompt";
      s.permissions.allow = ["Read"];
      s.permissions.deny = ["Bash(rm *)"];
    });
    await fireEvent.click(screen.getByRole("radio", { name: "bypass" }));
    expect(spec.permissions.mode).toBe("bypass");
    expect(spec.permissions.allow).toEqual([]);
    expect(spec.permissions.deny).toEqual([]);
  });

  it("leaves rules alone when the mode is set to prompt", async () => {
    const spec = renderSpec((s) => {
      s.permissions.mode = "prompt";
      s.permissions.allow = ["Read"];
    });
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(spec.permissions.allow).toEqual(["Read"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `app/`: `npx vitest run src/lib/components/ComposePane.test.ts`

Expected: FAIL on "clears entered rules when the mode flips back to bypass" — `spec.permissions.allow` is still `["Read"]`.

- [ ] **Step 3: Implement the handler**

In `app/src/lib/components/ComposePane.svelte`, add below the existing `parseRules` helper (after line 105):

```ts
  // Rules are only consulted under prompt mode and the engine rejects a spec
  // that carries them under bypass. The editors are hidden there, so keeping
  // the values would produce a validation error naming a field the operator
  // cannot see — drop them with the mode instead.
  function onPermissionMode(mode: "bypass" | "prompt") {
    spec.permissions.mode = mode;
    if (mode === "bypass") {
      spec.permissions.allow = [];
      spec.permissions.deny = [];
    }
  }
```

Then replace the mode `Segmented` (lines 281-285) — note `bind:value` becomes a plain `value` plus `onChange`:

```svelte
      <Segmented
        options={["bypass", "prompt"] as const}
        value={spec.permissions.mode}
        onChange={onPermissionMode}
        ariaLabel="Permission mode"
      />
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `app/`: `npx vitest run src/lib/components/ComposePane.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/components/ComposePane.svelte app/src/lib/components/ComposePane.test.ts
git commit -m "fix(workbench): clear permission rules when the mode returns to bypass"
```

---

## Task 4: Warn inline when `ask` has no operator, and offer the fix

**Files:**
- Modify: `app/src/styles/workbench.css:43` (add one variant line)
- Modify: `app/src/lib/components/ComposePane.svelte` (imports + the prompt branch)
- Modify: `app/src/lib/components/ComposePane.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/components/ComposePane.test.ts`:

```ts
const ASK_WARNING = /needs an operator/i;

describe("ComposePane permissions — the ask/interactive warning", () => {
  it("shows no warning under bypass", () => {
    renderSpec();
    expect(screen.queryByText(ASK_WARNING)).toBeNull();
  });

  it("warns when prompt + ask has interactive off", async () => {
    renderSpec();
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(screen.getByText(ASK_WARNING)).toBeInTheDocument();
  });

  it("shows no warning when unmatched is deny", async () => {
    renderSpec((s) => (s.permissions.mode = "prompt"));
    await fireEvent.click(screen.getByRole("radio", { name: "deny" }));
    expect(screen.queryByText(ASK_WARNING)).toBeNull();
  });

  it("shows no warning when interactive is already on", () => {
    renderSpec((s) => {
      s.permissions.mode = "prompt";
      s.interactive.enabled = true;
    });
    expect(screen.queryByText(ASK_WARNING)).toBeNull();
  });

  it("enables interactive from the fix button and dismisses the warning", async () => {
    const spec = renderSpec((s) => (s.permissions.mode = "prompt"));
    await fireEvent.click(screen.getByRole("button", { name: "Enable interactive" }));
    expect(spec.interactive.enabled).toBe(true);
    expect(screen.queryByText(ASK_WARNING)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `app/`: `npx vitest run src/lib/components/ComposePane.test.ts`

Expected: FAIL — "warns when prompt + ask has interactive off" finds no such text, and the fix-button test finds no such button.

- [ ] **Step 3: Add the warning banner variant**

In `app/src/styles/workbench.css`, immediately after line 43 (`.wb-banner--error { ... }`) add:

```css
.wb-banner--warning { background: var(--warning-subtle); color: var(--warning-text); }
```

- [ ] **Step 4: Render the warning**

In `app/src/lib/components/ComposePane.svelte`, add the icon import alongside the existing `@lucide/svelte` imports at the top of the `<script>` block:

```ts
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
```

(If `AlertTriangle` is already imported in this file, skip this — do not import it twice.)

Then, inside the `{#if spec.permissions.mode === "prompt"}` branch, directly after the closing `</Field>` of the Unmatched control (line 298) and before the Allow field, insert:

```svelte
      {#if spec.permissions.unmatched === "ask" && !spec.interactive.enabled}
        <div class="wb-banner wb-banner--warning" role="alert">
          <AlertTriangle size={15} />
          <div class="wb-banner__list">
            <span>unmatched = "ask" needs an operator to ask, and interactive is off.</span>
          </div>
          <button type="button" class="k-btn" onclick={() => (spec.interactive.enabled = true)}>
            Enable interactive
          </button>
        </div>
      {/if}
```

- [ ] **Step 5: Run the test to verify it passes**

Run from `app/`: `npx vitest run src/lib/components/ComposePane.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/components/ComposePane.svelte app/src/lib/components/ComposePane.test.ts app/src/styles/workbench.css
git commit -m "feat(workbench): warn inline when unmatched = ask has no operator"
```

---

## Task 5: Give the browser demo a permission pause

**Files:**
- Modify: `app/src/lib/mock.ts:30-47` (`seedSpec`) and `:49-80` (the timeline)
- Modify: `app/src/lib/api.ts:57-109` (`runSpec`, `submitAnswer`, `submitDecision`, the resume helper)

- [ ] **Step 1: Make the seeded demo spec coherent**

In `app/src/lib/mock.ts`, in `seedSpec`, replace the `interactive` and `permissions` lines (currently 44-45) with:

```ts
    interactive: { enabled: true, answer_timeout_secs: null },
    permissions: { mode: "prompt", allow: ["Read", "Grep", "Bash(dotnet *)"], deny: ["Bash(rm *)"], unmatched: "ask" },
```

The old value scripted an `ask.requested` against a spec with interactive off, and now scripts a permission pause too. Both need `interactive.enabled = true`, and `unmatched = "ask"` requires it under the rules added in Task 2.

- [ ] **Step 2: Split the timeline into three segments**

In `app/src/lib/mock.ts`, replace both timeline exports (lines 49-80, `runScriptHead` and `runScriptTail`) with:

```ts
export type ScriptStep = { delay: number; ev: KataEvent };

/** The scripted timeline, in the order the operator unblocks it:
 *  head → (ask.requested pause) → mid → (permission.requested pause) → tail.
 *  `api.runSpec` schedules the head, `api.submitAnswer` the mid, and
 *  `api.submitDecision` the tail. */
export const runScriptHead: ScriptStep[] = [
  { delay: 250, ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
  { delay: 350, ev: { type: "log", level: "info", message: "worktree: ./.kata/wt-3f9a off main" } },
  { delay: 500, ev: { type: "turn", n: 1 } },
  { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake: I'll run the single test in a tight loop and watch for the failure mode.\n\n```bash\nfor i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done\n```" } },
  { delay: 400, ev: { type: "permission.decided", id: "d1", tool: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done", allow: true, decided_by: "allow-rule" } },
  { delay: 300, ev: { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" } },
  { delay: 1300, ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" } },
  { delay: 500, ev: { type: "turn", n: 2 } },
  { delay: 250, ev: { type: "assistant.text", text: "It fails ~1 in 10 locally. The failures share a **timestamp boundary** — this smells like a clock-skew race in `TokenValidator.IsExpired`." } },
  { delay: 400, ev: { type: "ask.requested", id: "q1", questions: [
    { kind: "select", header: "scope", question: "Fix the flake, or just isolate it?",
      options: [ { label: "Isolate only", description: "as instructed" }, { label: "Fix it", description: "change prod code" } ],
      multi_select: false },
  ] } },
];

/** Replayed after the operator answers the ask; ends on the permission pause. */
export const runScriptMid: ScriptStep[] = [
  { delay: 500, ev: { type: "permission.decided", id: "d2", tool: "Read", input_summary: "src/Auth/TokenValidator.cs", allow: true, decided_by: "allow-rule" } },
  { delay: 300, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs" } },
  { delay: 850, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines" } },
  { delay: 500, ev: { type: "turn", n: 3 } },
  { delay: 250, ev: { type: "assistant.text", text: "Found it. `IsExpired` compares `DateTime.UtcNow` against an expiry built with `DateTime.Now` upstream — across the DST/second boundary the two clocks disagree and the token reads as expired.\n\nI'd like to stash the scratch build output before I write the report." } },
  { delay: 500, ev: { type: "permission.requested", id: "p1", tool: "Bash", input_summary: "rm -rf ./.kata/wt-3f9a/scratch" } },
];

/** Replayed after the operator settles the permission check. */
export const runScriptTail: ScriptStep[] = [
  { delay: 600, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } },
  { delay: 700, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only, as instructed" } },
  { delay: 500, ev: { type: "turn", n: 4 } },
  { delay: 250, ev: { type: "assistant.text", text: "**Smallest repro:** pin the system clock to `23:59:59.6` local and call `LoginExpiry` once — it fails deterministically.\n\n**Cause:** `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\nNo production code changed." } },
  { delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 4, cost_usd: 0.041, duration_ms: 48120,
    result: "## Isolation Report\n\nIsolated `AuthTests.LoginExpiry` flake to a **clock-skew race**: `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\n| Field | Value |\n|---|---|\n| Cause | Mixed Now/UtcNow in token expiry |\n| Repro | Pin clock to `23:59:59.6` local |\n| Prod code changed | No |\n\nNo production code was changed." } },
];
```

Note the `git diff --stat` call in the tail deliberately has **no** preceding `permission.decided` — the demo does not need an audit row for every call, and the store only requires one for checks that pause.

- [ ] **Step 3: Drive the segments from the api bridge**

In `app/src/lib/api.ts`, update the import on line 8 to pull in the new segment:

```ts
import { inTauri, seedCatalog, validateLocal, runScriptHead, runScriptMid, runScriptTail } from "$lib/mock";
import type { ScriptStep } from "$lib/mock";
```

Replace `resumeMockAfterAnswer` (lines 102-109) with a generalized scheduler, and place it above `runSpec` so all three callers can use it:

```ts
/** Schedule one segment of the scripted browser timeline. */
function playMock(segment: ScriptStep[]): void {
  let acc = 0;
  for (const step of segment) {
    acc += step.delay;
    browserTimers.push(setTimeout(() => browserCb?.(step.ev), acc));
  }
}
```

Then `runSpec`'s browser branch (lines 60-64) becomes:

```ts
  playMock(runScriptHead);
```

`submitAnswer`'s browser branch (lines 77-79) becomes:

```ts
  // Browser mock: resolve the scripted pause by feeding an ask.answered + resume.
  browserCb?.({ type: "ask.answered", id, answers });
  playMock(runScriptMid);
```

And `submitDecision`'s browser branch (lines 89-99) becomes — it now echoes the request it is answering instead of inventing a tool call:

```ts
  // Browser mock: settle the scripted pause with the operator's verdict. The
  // tool/input echo the permission.requested in runScriptMid.
  browserCb?.({
    type: "permission.decided",
    id,
    tool: "Bash",
    input_summary: "rm -rf ./.kata/wt-3f9a/scratch",
    allow,
    decided_by: "operator",
    message: message ?? undefined,
  });
  playMock(runScriptTail);
```

- [ ] **Step 4: Verify the suite still passes**

Run from `app/`: `npm test`

Expected: PASS. If a test referenced `runScriptTail` expecting the old contents, update that test to the new segment names — check with `grep -rn "runScript" src/`.

- [ ] **Step 5: Type-check**

Run from `app/`: `npm run check`
Expected: 0 errors. (`decided_by` is a plain `string` in the generated bindings, so `"allow-rule"` type-checks.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/mock.ts app/src/lib/api.ts
git commit -m "feat(workbench): script a permission pause into the browser demo timeline"
```

---

## Task 6: Verify the whole thing, with evidence

**Files:** none modified (unless a check fails)

- [ ] **Step 1: Full frontend suite**

Run from `app/`: `npm test`
Expected: PASS. Record the file and test counts — they must exceed the 85-test baseline.

- [ ] **Step 2: Svelte type-check**

Run from `app/`: `npm run check`
Expected: 0 errors, 0 warnings from our files.

- [ ] **Step 3: Rust unchanged and still green**

Run from the repo root:

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -p kata-core -p kata-cli
```

Expected: fmt clean, clippy clean, all engine tests pass. No Rust file should appear in `git diff` for this plan — if one does, something went wrong.

- [ ] **Step 4: See the card render**

Start the dev server from `app/`: `npm run dev`, then drive `http://localhost:1420/?demo=run` in a browser (the Chrome DevTools MCP tools work well here). Walk the whole timeline:

1. The run starts and streams turns 1-2.
2. An **allowed** audit row appears for the `dotnet test` call (`Bash … · allow-rule`, jade).
3. The ask card appears; answer it.
4. A second audit row appears for the `Read`.
5. **The approval card appears** for `rm -rf ./.kata/wt-3f9a/scratch`, and the status badge reads `Awaiting`.
6. Click **Deny** with a reason; confirm the card settles showing the reason, the status returns to `Running`, and the run completes.
7. Reload and repeat, clicking **Allow · resume** instead; confirm it settles as allowed.

Capture a screenshot of the pending approval card.

- [ ] **Step 5: Check the compose pane visually**

In the same browser session, in the compose pane: flip Permissions mode to `prompt` and confirm the amber warning renders with the **Enable interactive** button; click it and confirm the warning disappears. Add allow rules, flip back to `bypass`, flip to `prompt` again, and confirm the rules are gone.

- [ ] **Step 6: Commit any fixes**

If steps 1-5 surfaced a defect, fix it, add a regression test for it, and commit. If everything passed, there is nothing to commit — say so plainly rather than inventing a commit.

---

## Definition of done

- `npm test` green, with new coverage for `PermissionPanel`, the compose permission controls, and `validateLocal`'s permission mirror.
- `npm run check` clean.
- `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p kata-core -p kata-cli` all green, with no Rust changes in the diff.
- The approval card observed rendering and settling both ways in a real browser, with a screenshot.
- The compose pane cannot produce a spec that carries rules under `bypass`, and warns with a one-click fix before `ask` can strand a run with no operator.

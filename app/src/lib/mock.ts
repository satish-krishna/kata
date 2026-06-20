/* Dev-only fallback fixtures.
 *
 * The Workbench's real data comes from the Rust/Tauri command bridge. When the
 * SvelteKit SPA is opened in a plain browser (e.g. `vite dev` for design review
 * or screenshots) those commands are unreachable, so we stand in with the same
 * fixtures the design prototype used. Under the real Tauri runtime this module
 * is never consulted — see `inTauri()` in api.ts. */
import type { RunSpec } from "../bindings/RunSpec";
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { KataEvent } from "./events";

/** True when running inside the Tauri webview (real backend available). */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Shape of `kata catalog` — mirrors the discovered skills/plugins. */
export const seedCatalog: CatalogEntry[] = [
  { kind: "skill", name: "triage-flaky-test", description: "reproduce & isolate a flaky test", source: "user", path: "~/.kata/skills/triage-flaky-test", provides: [], mcp_servers: [] },
  { kind: "skill", name: "doc-writer", description: "write & update project docs", source: "user", path: "~/.kata/skills/doc-writer", provides: [], mcp_servers: [] },
  { kind: "skill", name: "perf-profiler", description: "profile a hot path & report", source: "user", path: "~/.kata/skills/perf-profiler", provides: [], mcp_servers: [] },
  { kind: "plugin", name: "github-tools", description: "PRs, issues, releases", source: "user", path: "~/.kata/plugins/github-tools", provides: ["skill:pr-review", "skill:issue-triage"], mcp_servers: ["github"] },
  { kind: "plugin", name: "sentry", description: "read issues & stack traces", source: "user", path: "~/.kata/plugins/sentry", provides: ["skill:error-triage"], mcp_servers: ["sentry"] },
];

/** A representative starting spec for browser dev/review (the prototype's
 *  triage-flaky-test example). The real Tauri app opens a blank `New` spec
 *  (see defaultSpec in spec.ts); this only seeds the browser fallback so the
 *  redesign can be reviewed populated. */
export function seedSpec(): RunSpec {
  return {
    schema: 1,
    name: "triage-flaky-test",
    description: "Reproduce and isolate AuthTests.LoginExpiry",
    task: "Triage the flaky test AuthTests.LoginExpiry. Find the smallest reproduction and your best guess at the cause.",
    context: ".NET 8 xUnit suite. CI flakes ~1 in 30 runs. Don't fix it, just isolate.",
    workdir: "D:/Repos/acme-api",
    identity: { system_prompt: "You reproduce, isolate, and report. You do not change production code.", mode: "append" },
    skills: ["triage-flaky-test"],
    plugins: { "github-tools": { mcp: true, env: ["GITHUB_TOKEN", "GH_HOST"] } },
    model: { id: "claude-sonnet-4-6" },
    leash: { max_turns: 12, timeout_secs: 900, max_budget_usd: null, isolation: "worktree" },
    auth: { bare: true, token_env: null },
    interactive: { enabled: false, answer_timeout_secs: null },
  };
}

/** The head of the scripted timeline — fires until the ask.requested pause.
 *  `api.runSpec` schedules these; `api.submitAnswer` resumes the tail. */
export const runScriptHead: { delay: number; ev: KataEvent }[] = [
  { delay: 250, ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
  { delay: 350, ev: { type: "log", level: "info", message: "worktree: ./.kata/wt-3f9a off main" } },
  { delay: 500, ev: { type: "turn", n: 1 } },
  { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake: I'll run the single test in a tight loop and watch for the failure mode.\n\n```bash\nfor i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done\n```" } },
  { delay: 700, ev: { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" } },
  { delay: 1300, ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" } },
  { delay: 500, ev: { type: "turn", n: 2 } },
  { delay: 250, ev: { type: "assistant.text", text: "It fails ~1 in 10 locally. The failures share a **timestamp boundary** — this smells like a clock-skew race in `TokenValidator.IsExpired`." } },
  { delay: 400, ev: { type: "ask.requested", id: "q1", questions: [
    { kind: "select", header: "scope", question: "Fix the flake, or just isolate it?",
      options: [ { label: "Isolate only", description: "as instructed" }, { label: "Fix it", description: "change prod code" } ],
      multi_select: false },
  ] } },
];

/** The tail of the scripted timeline — replayed by `api.submitAnswer` after the
 *  operator answers the ask. */
export const runScriptTail: { delay: number; ev: KataEvent }[] = [
  { delay: 800, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs" } },
  { delay: 850, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines" } },
  { delay: 500, ev: { type: "turn", n: 3 } },
  { delay: 250, ev: { type: "assistant.text", text: "Found it. `IsExpired` compares `DateTime.UtcNow` against an expiry built with `DateTime.Now` upstream — across the DST/second boundary the two clocks disagree and the token reads as expired." } },
  { delay: 800, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } },
  { delay: 700, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only, as instructed" } },
  { delay: 500, ev: { type: "turn", n: 4 } },
  { delay: 250, ev: { type: "assistant.text", text: "**Smallest repro:** pin the system clock to `23:59:59.6` local and call `LoginExpiry` once — it fails deterministically.\n\n**Cause:** `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\nNo production code changed." } },
  { delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 4, cost_usd: 0.041, duration_ms: 48120,
    result: "## Isolation Report\n\nIsolated `AuthTests.LoginExpiry` flake to a **clock-skew race**: `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\n| Field | Value |\n|---|---|\n| Cause | Mixed Now/UtcNow in token expiry |\n| Repro | Pin clock to `23:59:59.6` local |\n| Prod code changed | No |\n\nNo production code was changed." } },
];

/** Client-side mirror of `kata-core::spec::validate` (see lib.rs validate_spec). */
export function validateLocal(spec: RunSpec): string[] {
  const errs: string[] = [];
  if (spec.schema !== 1) errs.push(`unsupported schema version ${spec.schema} (expected 1)`);
  if (!spec.name || !spec.name.trim()) errs.push("name is required");
  if (!spec.task || !spec.task.trim()) errs.push("task is required");
  if (!spec.workdir || !spec.workdir.trim()) errs.push("workdir is required");
  if (spec.leash.max_turns != null && spec.leash.max_turns < 1) errs.push("leash.max_turns must be >= 1");
  return errs;
}

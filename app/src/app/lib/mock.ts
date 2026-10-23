/* Dev-only fallback fixtures.
 *
 * The Workbench's real data comes from the Rust/Tauri command bridge. When the
 * app is opened in a plain browser (e.g. `npm start` for design review
 * or screenshots) those commands are unreachable, so we stand in with the same
 * fixtures the design prototype used. Under the real Tauri runtime this module
 * is never consulted: `provideKataTransport` picks the Tauri transport. */
import type { RunSpec } from "@bindings/RunSpec";
import type { CatalogEntry } from "@bindings/CatalogEntry";
import type { EnvName } from "@bindings/EnvName";
import type { ItemKind } from "@bindings/ItemKind";
import type { LockReason } from "@bindings/LockReason";
import type { Resolved } from "@bindings/Resolved";
import type { ResolvedItem } from "@bindings/ResolvedItem";
import type { RunSetting } from "@bindings/RunSetting";
import type { RunSettings } from "@bindings/RunSettings";
import type { SettingSource } from "@bindings/SettingSource";
import type { Source } from "@bindings/Source";
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
    interactive: { enabled: true, answer_timeout_secs: null },
    permissions: { mode: "prompt", allow: ["Read", "Grep", "Bash(dotnet *)"], deny: ["Bash(rm *)"], unmatched: "ask" },
  };
}

export type ScriptStep = { delay: number; ev: KataEvent };

/** The scripted timeline, in the order the operator unblocks it:
 *  head → (ask.requested pause) → mid → (permission.requested pause) → tail.
 *
 *  Note what is NOT here: a `permission.decided` for a call a rule resolved.
 *  Under prompt mode the spec's rules go into a generated claude settings file,
 *  so claude settles those itself and Kata never sees them — a denial shows up
 *  as an ordinary failed `tool.result`, and only an unmatched call reaches Kata
 *  and pauses the run.
 *  `api.runSpec` schedules the head, `api.submitAnswer` the mid, and
 *  `api.submitDecision` the tail. */
export const runScriptHead: ScriptStep[] = [
  { delay: 250, ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
  { delay: 350, ev: { type: "log", level: "info", message: "worktree: ./.kata/wt-3f9a off main" } },
  { delay: 500, ev: { type: "turn", n: 1 } },
  { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake: I'll hammer the single test and watch for the failure mode.\n\n```bash\ndotnet test --filter AuthTests.LoginExpiry\n```" } },
  { delay: 200, ev: { type: "tool.use", name: "TodoWrite", input_summary: "{\"todos\":[…]}", id: "toolu_todo1", input: { todos: [
    { content: "Reproduce the LoginExpiry flake", status: "in_progress" },
    { content: "Find the root cause", status: "pending" },
    { content: "Write the isolation report", status: "pending" },
  ] } } },
  { delay: 150, ev: { type: "tool.result", name: "TodoWrite", ok: true, summary: "Todos updated", id: "toolu_todo1", output: "Todos have been modified successfully." } },
  { delay: 300, ev: { type: "tool.use", name: "Bash", input_summary: "dotnet test --filter AuthTests.LoginExpiry", id: "toolu_bash1", input: { command: "dotnet test --filter AuthTests.LoginExpiry", description: "Hammer the flaky test" } } },
  { delay: 1300, ev: { type: "tool.result", name: "Bash", ok: true, summary: "3 of 30 runs failed — iterations 8, 19, 26", id: "toolu_bash1", output: "Passed!  - Failed: 0, Passed: 1 (run 1)\n…\nFailed!  - Failed: 1, Passed: 0 (run 8)\n  AuthTests.LoginExpiry: token reported expired 0.4s early\n…\n3 of 30 runs failed — iterations 8, 19, 26" } },
  { delay: 500, ev: { type: "turn", n: 2 } },
  { delay: 250, ev: { type: "assistant.text", text: "It fails ~1 in 10 locally. The failures share a **timestamp boundary** — this smells like a clock-skew race in `TokenValidator.IsExpired`." } },
  { delay: 400, ev: { type: "ask.requested", id: "q1", questions: [
    { kind: "select", header: "scope", question: "Fix the flake, or just isolate it?",
      options: [ { label: "Isolate only", description: "as instructed" }, { label: "Fix it", description: "change prod code" } ],
      multi_select: false },
  ] } },
];

/** The one permission check the scripted demo puts to the operator. Exported so
 *  `api.submitDecision`'s echoed verdict cannot drift out of sync with it. */
export const PENDING_PERMISSION = { tool: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } as const;

/** Replayed after the operator answers the ask; ends on the permission pause. */
export const runScriptMid: ScriptStep[] = [
  { delay: 300, ev: { type: "tool.use", name: "Agent", input_summary: "Explore: find expiry comparisons", id: "toolu_agent1", input: { subagent_type: "Explore", description: "find expiry comparisons", prompt: "Find every place token expiry is computed or compared in src/Auth and report which clock each one uses." } } },
  { delay: 400, ev: { type: "tool.use", name: "Grep", input_summary: "IsExpired|ExpiresAt", id: "toolu_grep1", parent_id: "toolu_agent1", input: { pattern: "IsExpired|ExpiresAt", path: "src/Auth" } } },
  { delay: 350, ev: { type: "tool.result", name: "Grep", ok: true, summary: "4 matches", id: "toolu_grep1", parent_id: "toolu_agent1", output: "src/Auth/TokenValidator.cs:41\nsrc/Auth/TokenValidator.cs:58\nsrc/Auth/TokenIssuer.cs:22\nsrc/Auth/SessionStore.cs:107" } },
  { delay: 300, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs", id: "toolu_read1", parent_id: "toolu_agent1", input: { file_path: "src/Auth/TokenValidator.cs" } } },
  { delay: 600, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines", id: "toolu_read1", parent_id: "toolu_agent1", output: "    38\tpublic bool IsExpired(Token t)\n    39\t{\n    40\t    // expiry was stamped by TokenIssuer\n    41\t    return DateTime.UtcNow > t.ExpiresAt;\n    42\t}" } },
  { delay: 400, ev: { type: "tool.result", name: "Agent", ok: true, summary: "TokenIssuer stamps with DateTime.Now", id: "toolu_agent1", output: "TokenValidator.cs:41 compares DateTime.UtcNow; TokenIssuer.cs:22 stamps ExpiresAt with DateTime.Now. The other two use UtcNow consistently." } },
  { delay: 500, ev: { type: "turn", n: 3 } },
  { delay: 400, ev: { type: "tool.use", name: "Bash", input_summary: "git log --oneline -3", id: "toolu_bash2", input: { command: "git log --oneline -3" } } },
  { delay: 300, ev: { type: "tool.result", name: "Bash", ok: false, summary: "Permission to use Bash with command git log --oneline -3 has been denied.", id: "toolu_bash2", output: "Permission to use Bash with command git log --oneline -3 has been denied." } },
  { delay: 250, ev: { type: "assistant.text", text: "Found it. `IsExpired` compares `DateTime.UtcNow` against an expiry built with `DateTime.Now` upstream — across the DST/second boundary the two clocks disagree and the token reads as expired.\n\nLet me confirm I've left the worktree clean before I write the report." } },
  { delay: 500, ev: { type: "permission.requested", id: "p1", ...PENDING_PERMISSION } },
];

/** Replayed after the operator settles the permission check. */
export const runScriptTail: ScriptStep[] = [
  { delay: 600, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat", id: "toolu_bash3", input: { command: "git -C ./.kata/wt-3f9a diff --stat" } } },
  { delay: 700, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only, as instructed", id: "toolu_bash3", output: "" } },
  { delay: 500, ev: { type: "turn", n: 4 } },
  { delay: 250, ev: { type: "assistant.text", text: "**Smallest repro:** pin the system clock to `23:59:59.6` local and call `LoginExpiry` once — it fails deterministically.\n\n**Cause:** `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\nNo production code changed." } },
  { delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 4, cost_usd: 0.041, duration_ms: 48120,
    result: "## Isolation Report\n\nIsolated `AuthTests.LoginExpiry` flake to a **clock-skew race**: `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\n| Field | Value |\n|---|---|\n| Cause | Mixed Now/UtcNow in token expiry |\n| Repro | Pin clock to `23:59:59.6` local |\n| Prod code changed | No |\n\nNo production code was changed." } },
];

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
  if (spec.leash.max_turns != null && spec.leash.max_turns < 1) errs.push("leash.max_turns must be >= 1 when set");

  // Permissions — a setting that would be silently ignored is an error, so a
  // spec never looks like it constrains a run when it does not.
  const p = spec.permissions;
  const allow = p.allow ?? [];
  const deny = p.deny ?? [];
  const ask = p.ask ?? [];
  if (p.mode === "bypass") {
    if (allow.length > 0 || deny.length > 0 || ask.length > 0) {
      errs.push(
        'permissions.allow/deny/ask are only consulted under permissions.mode = "prompt" or "auto"; ' +
          'under "bypass" claude never asks, so the rules would be ignored',
      );
    }
  } else if (p.mode === "prompt") {
    if (p.unmatched === "ask" && !spec.interactive.enabled) {
      errs.push(
        'permissions.unmatched = "ask" needs an operator to ask: set [interactive] enabled = true, ' +
          'or choose unmatched = "deny" / "allow" for a headless run',
      );
    }
  } else if (p.mode === "auto") {
    if (p.unmatched && p.unmatched !== "ask") {
      errs.push(
        'permissions.unmatched has no meaning under permissions.mode = "auto": ' +
          "claude's classifier decides every call no rule matched. Remove it, or use " +
          'mode = "prompt" to route unmatched calls to the operator.',
      );
    }
  }
  // ask rules pause on the operator, so someone must be there to answer. This
  // holds under both prompt and auto; bypass already rejected them above.
  if (ask.length > 0 && p.mode !== "bypass" && !spec.interactive.enabled) {
    errs.push(
      "permissions.ask rules pause on the operator: set [interactive] enabled = true, or remove them",
    );
  }
  // Rule shape is checked unconditionally, as in the engine: a malformed rule
  // is malformed under any mode, and a bypass spec can earn both errors at once.
  for (const [field, rules] of [
    ["permissions.allow", allow],
    ["permissions.deny", deny],
    ["permissions.ask", ask],
  ] as const) {
    for (const raw of rules) {
      if (!ruleIsWellFormed(raw)) {
        errs.push(`${field} has a malformed rule '${raw}'; expected 'Tool' or 'Tool(specifier)'`);
      }
    }
  }
  return errs;
}

const SUPERPOWERS = "superpowers@claude-plugins-official";
const SDLC_PLUGIN = "ai-sdlc@ai-sdlc";
const UNSWITCHABLE: LockReason = { kind: "unswitchable", text: "Kata cannot switch this off for one run without editing your setup" };

/** The last folder of a path, either slash style. */
function lastFolder(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
}

/** What `preview_run` returns, for the browser. One item of every R2.1 row, in the engine's order
 *  (kind, then source, then name), with the engine's ids and locks. Project items carry the last
 *  folder of `spec.workdir`, so two repositories preview differently. */
export function previewFixture(spec: RunSpec): Resolved {
  const folder = lastFolder(spec.workdir);
  const sdlcRequired = (spec.given?.required_plugins ?? []).includes("ai-sdlc");
  const requiredLock: LockReason = { kind: "required", text: "AI-SDLC runs work through this plugin" };
  const kataLock: LockReason = { kind: "kata", text: "the run needs it to ask you questions" };
  const orgLock: LockReason = { kind: "organization", text: "set by your organization" };
  const make = (kind: ItemKind, source: Source, key: string, name: string, detail: string, extra: Partial<ResolvedItem> = {}): ResolvedItem => ({
    id: `${source}:${kind}:${key}`, kind, source, name, detail, path: null, brought_by: null, lock: null, off: false, ...extra,
  });
  const plugin = (key: string, source: Source, detail: string, lock: LockReason | null = null): ResolvedItem =>
    make("plugin", source, key, key.split("@")[0], detail, { lock });
  const child = (kind: ItemKind, key: string, name: string, detail: string, parentKey: string, parentRequired: boolean): ResolvedItem => {
    const parent = `personal:plugin:${parentKey}`;
    return make(kind, "plugin", `${parentKey}:${key}`, name, detail, {
      brought_by: parent,
      lock: parentRequired ? requiredLock : { kind: "follows-plugin", plugin: parent },
    });
  };
  const items: ResolvedItem[] = [
    make("hook", "personal", "PreToolUse:Bash:5b5b1d0c9a2e4f10", "PreToolUse Bash", "node ~/.claude/hooks/guard.mjs", { lock: UNSWITCHABLE }),
    make("hook", "project", "PostToolUse:Write|Edit:8c1f77e2d3a40b95", "PostToolUse Write|Edit", "npm run lint --silent", { lock: UNSWITCHABLE }),
    child("hook", "SessionStart:*:15b9f33b1f620354", "SessionStart *", "inject the using-superpowers skill", SUPERPOWERS, false),
    make("hook", "organization", "PreToolUse:*:2f6d0a91c7e85b34", "PreToolUse *", "audit every tool call", { lock: orgLock }),
    make("skill", "personal", "triage-flaky-test", "triage-flaky-test", "reproduce & isolate a flaky test", { path: "~/.claude/skills/triage-flaky-test", lock: UNSWITCHABLE }),
    make("skill", "project", `${folder}-conventions`, `${folder}-conventions`, `how ${folder} is built and tested`, { path: `${spec.workdir}/.claude/skills/${folder}-conventions`, lock: UNSWITCHABLE }),
    child("skill", "brainstorming", "brainstorming", "explore intent before building", SUPERPOWERS, false),
    child("skill", "spec", "spec", "turn an accepted intent into a spec", SDLC_PLUGIN, sdlcRequired),
    make("skill", "run-spec", "doc-writer", "doc-writer", "write & update project docs", { path: "~/.kata/skills/doc-writer" }),
    plugin(SDLC_PLUGIN, "personal", "AI-SDLC stages", sdlcRequired ? requiredLock : null),
    plugin(SUPERPOWERS, "personal", "skills and hooks for disciplined work"),
    plugin(`${folder}-tools@${folder}`, "project", `tools installed for ${folder}`),
    make("plugin", "run-spec", "github-tools", "github-tools", "PRs, issues, releases", { path: "~/.kata/plugins/github-tools" }),
    make("instruction", "personal", "CLAUDE.md", "CLAUDE.md", "your standing instructions", { path: "~/.claude/CLAUDE.md" }),
    make("instruction", "project", "CLAUDE.md", "CLAUDE.md", `${folder}'s standing instructions`, { path: `${spec.workdir}/CLAUDE.md` }),
    make("instruction", "kata", "standing-note", "Kata's standing note", "tells the run to ask through ask_user", { lock: kataLock }),
    make("instruction", "run-spec", "identity", "Run-spec instruction", "the identity prompt this run-spec carries"),
    make("tool-server", "personal", "github", "github", "npx @modelcontextprotocol/server-github"),
    make("tool-server", "project", `${folder}-db`, `${folder}-db`, "read-only database access"),
    child("tool-server", "memory", "memory", "remembers across sessions", SUPERPOWERS, false),
    make("tool-server", "kata", "kata-ask", "kata-ask", "the ask_user and approve_tool tools", { lock: kataLock }),
  ];

  const given = spec.given;
  const listed = new Set([...(given?.hooks ?? []), ...(given?.skills ?? []), ...(given?.plugins ?? []), ...(given?.instructions ?? []), ...(given?.tool_servers ?? [])]);
  const known = new Set(items.map((i) => i.id));
  for (const i of items) if (!i.lock && listed.has(i.id)) i.off = true;
  for (const i of items) {
    if (i.lock?.kind === "follows-plugin") i.off = items.find((p) => p.id === (i.lock as { plugin: string }).plugin)?.off ?? false;
  }

  const setting = (value: string | null, source: SettingSource): RunSetting => ({ value, source });
  const timeout = spec.leash.timeout_secs;
  const settings: RunSettings = {
    model: spec.model.id ? setting(spec.model.id, "run-spec") : setting(null, "claude-default"),
    effort: setting(null, "claude-default"),
    permission_posture: setting(spec.permissions.mode, "run-spec"),
    empty_room: setting(spec.auth.bare ? "on" : "off", "run-spec"),
    answer_deadline: spec.interactive.answer_timeout_secs ? setting(String(spec.interactive.answer_timeout_secs), "run-spec") : setting(null, "kata-default"),
    time_limit: timeout ? setting(String(timeout), "run-spec") : setting("1800", "kata-default"),
    turn_cap: setting(spec.leash.max_turns ? String(spec.leash.max_turns) : null, "run-spec"),
    spending_ceiling: setting(spec.leash.max_budget_usd ? String(spec.leash.max_budget_usd) : null, "run-spec"),
  };
  const env: EnvName[] = [
    { source: "personal", name: "GITHUB_TOKEN", api_key: false },
    { source: "personal", name: "ANTHROPIC_API_KEY", api_key: true },
  ];
  return { items, settings, env, missing: [...listed].filter((id) => !known.has(id)), problems: [] };
}

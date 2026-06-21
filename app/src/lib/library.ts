/* Library (Layout C) fixtures: saved katas (named run-specs) and local run
 * history. The history array now matches the generated RunRecord shape so that
 * it can be returned directly by the browser-fallback path in api.ts. When
 * running under Tauri, listRuns() calls the live list_runs command instead. */
import type { StreamEvent } from "./events";
import type { RunRecord, RunDetail } from "./events";
import type { RunSpec } from "../bindings/RunSpec";
import type { Preset } from "../bindings/Preset";

export type { RunRecord };

export const history: RunRecord[] = [
  { id: "triage-flaky-test-20260618T142200Z", kata: "triage-flaky-test", started_at: 1750256520, isolation: "worktree", exit: 0, turns: 4, cost_usd: 0.041, duration_ms: 48120, result: "## Isolation Report\n\nIsolated `AuthTests.LoginExpiry` flake to a **clock-skew race**: `TokenValidator.IsExpired` mixes `DateTime.Now` (expiry) with `DateTime.UtcNow` (check).\n\n| Field | Value |\n|---|---|\n| Cause | Mixed Now/UtcNow in token expiry |\n| Repro | Pin clock to `23:59:59.6` local |\n| Prod code changed | No |\n\nNo production code was changed." },
  { id: "release-notes-20260618T110500Z", kata: "release-notes", started_at: 1750244700, isolation: "none", exit: 0, turns: 3, cost_usd: 0.028, duration_ms: 31540, result: "Drafted release notes for v2.4.0 from 18 merged PRs since v2.3.0; grouped by Added / Fixed / Changed." },
  { id: "audit-deps-20260617T174800Z", kata: "audit-deps", started_at: 1750182480, isolation: "none", exit: 125, turns: null, cost_usd: null, duration_ms: null, result: "reached max turns (12)" },
  { id: "triage-flaky-test-20260617T091400Z", kata: "triage-flaky-test", started_at: 1750151640, isolation: "worktree", exit: 0, turns: 5, cost_usd: 0.052, duration_ms: 61900, result: "Could not reproduce in 30 iterations on this commit; flake likely fixed by #1182. Recommend closing." },
  { id: "perf-sweep-20260616T160200Z", kata: "perf-sweep", started_at: 1750089720, isolation: "worktree", exit: 130, turns: null, cost_usd: null, duration_ms: null, result: "cancelled" },
  { id: "doc-refresh-20260616T103900Z", kata: "doc-refresh", started_at: 1750069140, isolation: "none", exit: 0, turns: 6, cost_usd: 0.061, duration_ms: 72400, result: "Updated README + 4 module docs for the renamed Auth API surface; 0 code changes." },
];

export const runStreams: Record<string, StreamEvent[]> = {
  "triage-flaky-test-20260618T142200Z": [
    { type: "log", message: "assembled plugin-dir: 1 skill, 1 plugin" },
    { type: "log", message: "worktree: ./.kata/wt-3f9a off main" },
    { type: "turn", n: 1 },
    { type: "assistant.text", text: "Reproducing the flake: running the single test in a tight loop to watch for the failure mode." },
    { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" },
    { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" },
    { type: "turn", n: 2 },
    { type: "assistant.text", text: "Failures share a timestamp boundary — smells like a clock-skew race in token expiry." },
    { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs" },
    { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines" },
    { type: "turn", n: 3 },
    { type: "assistant.text", text: "Found it: IsExpired compares DateTime.UtcNow against an expiry built with DateTime.Now upstream." },
  ],
  "audit-deps-20260617T174800Z": [
    { type: "log", message: "assembled plugin-dir: 2 skills, 1 plugin" },
    { type: "turn", n: 1 },
    { type: "assistant.text", text: "Enumerating direct + transitive dependencies and flagging unpinned or known-risky versions." },
    { type: "tool.use", name: "Bash", input_summary: "dotnet list package --include-transitive" },
    { type: "tool.result", name: "Bash", ok: true, summary: "61 packages, 9 unpinned" },
    { type: "turn", n: 12 },
    { type: "assistant.text", text: "Reached the turn cap at 41 of ~60 packages audited." },
  ],
  "perf-sweep-20260616T160200Z": [
    { type: "log", message: "assembled plugin-dir: 1 skill" },
    { type: "turn", n: 1 },
    { type: "tool.use", name: "Bash", input_summary: "dotnet-trace collect --process-id $(pidof api)" },
    { type: "tool.result", name: "Bash", ok: false, summary: "dotnet-trace: command not found" },
    { type: "assistant.text", text: "The profiler can't attach — dotnet-trace isn't on PATH in this workdir. Stopping; no data collected." },
  ],
};

/** Browser-fallback detail: the fixture record + its scripted stream as KataEvents. */
export function runDetailFixture(id: string): RunDetail {
  const record = history.find((r) => r.id === id) ?? history[0];
  return { record, events: (runStreams[record.id] ?? []) as RunDetail["events"] };
}

const fixtureSpec = (name: string, description: string, isolation: "none" | "worktree", skills: string[], plugins: string[]): RunSpec => ({
  schema: 1, name, description, task: "Do the kata.", workdir: "/repo",
  identity: { mode: "append" }, skills, plugins: Object.fromEntries(plugins.map((p) => [p, {}])) as RunSpec["plugins"],
  model: {}, leash: { max_turns: 12, isolation }, auth: { bare: true }, interactive: { enabled: false },
} as RunSpec);

export const katasFixture: RunSpec[] = [
  fixtureSpec("triage-flaky-test", "Reproduce & isolate AuthTests.LoginExpiry", "worktree", ["triage-flaky-test"], ["github-tools"]),
  fixtureSpec("release-notes", "Draft notes from the merged PRs since last tag", "none", ["release-notes"], ["github-tools"]),
  fixtureSpec("audit-deps", "List risky dependencies & propose pins", "none", ["audit", "deps"], ["github-tools"]),
];

export const presetsFixture: Preset[] = [
  { name: "dotnet repro", body: "Use `dotnet test --filter` to run a single test in a tight loop." },
  { name: "staging slot", body: "Target the staging deployment slot, never production." },
];

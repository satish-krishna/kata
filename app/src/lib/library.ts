/* Library (Layout C) fixtures: saved katas (named run-specs) and local run
 * history. There is no history backend yet — these seed the read-only Library
 * screen for review. When the history store lands (kata writes to ~/.kata/history),
 * swap these for the Tauri-loaded values; the components stay the same. */
import type { Isolation } from "../bindings/Isolation";
import type { RunState, StreamEvent } from "./events";

export interface SavedKata {
  name: string;
  description: string;
  isolation: Isolation;
  skills: number;
  plugins: number;
  lastState: RunState;
  lastExit: number;
  runs: number;
}

export interface RunRecord {
  id: string;
  kata: string;
  when: string;
  state: RunState;
  exit: number;
  turns: number;
  cost: number;
  ms: number;
  result: string;
}

export const savedKatas: SavedKata[] = [
  { name: "triage-flaky-test", description: "Reproduce & isolate AuthTests.LoginExpiry", isolation: "worktree", skills: 1, plugins: 1, lastState: "success", lastExit: 0, runs: 14 },
  { name: "release-notes", description: "Draft notes from the merged PRs since last tag", isolation: "none", skills: 1, plugins: 1, lastState: "success", lastExit: 0, runs: 31 },
  { name: "audit-deps", description: "List risky dependencies & propose pins", isolation: "none", skills: 2, plugins: 1, lastState: "warning", lastExit: 125, runs: 6 },
  { name: "perf-sweep", description: "Profile the hot path & report top offenders", isolation: "worktree", skills: 1, plugins: 0, lastState: "error", lastExit: 1, runs: 3 },
  { name: "doc-refresh", description: "Update README + module docs for changed APIs", isolation: "none", skills: 1, plugins: 0, lastState: "success", lastExit: 0, runs: 9 },
];

export const history: RunRecord[] = [
  { id: "r-2041", kata: "triage-flaky-test", when: "today · 14:22", state: "success", exit: 0, turns: 4, cost: 0.041, ms: 48120, result: "Isolated the flake to a clock-skew race in TokenValidator.IsExpired (mixed Now/UtcNow). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed." },
  { id: "r-2038", kata: "release-notes", when: "today · 11:05", state: "success", exit: 0, turns: 3, cost: 0.028, ms: 31540, result: "Drafted release notes for v2.4.0 from 18 merged PRs since v2.3.0; grouped by Added / Fixed / Changed." },
  { id: "r-2035", kata: "audit-deps", when: "yesterday · 17:48", state: "warning", exit: 125, turns: 12, cost: 0.092, ms: 140300, result: "Hit the 12-turn cap mid-audit. Covered 41 of ~60 dependencies; raise max_turns to finish." },
  { id: "r-2030", kata: "triage-flaky-test", when: "yesterday · 09:14", state: "success", exit: 0, turns: 5, cost: 0.052, ms: 61900, result: "Could not reproduce in 30 iterations on this commit; flake likely fixed by #1182. Recommend closing." },
  { id: "r-2026", kata: "perf-sweep", when: "Mon · 16:02", state: "error", exit: 1, turns: 2, cost: 0.014, ms: 18700, result: "Profiler plugin failed to attach: dotnet-trace not on PATH in workdir. No data collected." },
  { id: "r-2019", kata: "doc-refresh", when: "Mon · 10:39", state: "success", exit: 0, turns: 6, cost: 0.061, ms: 72400, result: "Updated README + 4 module docs for the renamed Auth API surface; 0 code changes." },
];

export const runStreams: Record<string, StreamEvent[]> = {
  "r-2041": [
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
  "r-2035": [
    { type: "log", message: "assembled plugin-dir: 2 skills, 1 plugin" },
    { type: "turn", n: 1 },
    { type: "assistant.text", text: "Enumerating direct + transitive dependencies and flagging unpinned or known-risky versions." },
    { type: "tool.use", name: "Bash", input_summary: "dotnet list package --include-transitive" },
    { type: "tool.result", name: "Bash", ok: true, summary: "61 packages, 9 unpinned" },
    { type: "turn", n: 12 },
    { type: "assistant.text", text: "Reached the turn cap at 41 of ~60 packages audited." },
  ],
  "r-2026": [
    { type: "log", message: "assembled plugin-dir: 1 skill" },
    { type: "turn", n: 1 },
    { type: "tool.use", name: "Bash", input_summary: "dotnet-trace collect --process-id $(pidof api)" },
    { type: "tool.result", name: "Bash", ok: false, summary: "dotnet-trace: command not found" },
    { type: "assistant.text", text: "The profiler can't attach — dotnet-trace isn't on PATH in this workdir. Stopping; no data collected." },
  ],
};

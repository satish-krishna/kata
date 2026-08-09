/* Run state store. Holds the observe-pane state machine and event buffer, and
 * drives the run via the api bridge. Components read `runStore` reactively;
 * the bridge (Tauri or browser fallback) feeds events in. */
import type { RunSpec } from "../bindings/RunSpec";
import type { KataEvent, StreamEvent, RunSummary, RunState, Question, PermissionRecord } from "./events";
import { terminalStateFor } from "./events";
import * as api from "./api";

export type AskRecord = { id: string; questions: Question[]; answers: string[][] | null };
export type { PermissionRecord };

export const runStore = $state<{
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
}>({ state: "idle", events: [], summary: null, asks: [], permissions: [] });

let unlisten: (() => void) | null = null;

function teardown() {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}

function handle(ev: KataEvent) {
  switch (ev.type) {
    case "run.started":
      return; // meta only; the status badges come from the spec
    case "run.completed":
      runStore.summary = ev;
      break;
    case "run.error":
      runStore.events.push({ type: "log", level: "error", message: ev.message });
      break;
    case "run.cancelled":
      break;
    case "run.diff":
      return; // meta only; the diff panel is a fast-follow
    case "ask.requested":
      runStore.asks.push({ id: ev.id, questions: ev.questions, answers: null });
      runStore.state = "awaiting";
      return;
    case "ask.answered": {
      const rec = runStore.asks.find((a) => a.id === ev.id);
      if (rec) rec.answers = ev.answers;
      runStore.state = "running";
      return;
    }
    case "permission.requested":
      runStore.permissions.push({
        id: ev.id,
        tool: ev.tool,
        input_summary: ev.input_summary,
        decided: null,
        // Stamp the position in the stream so the pane can render the card
        // where the check happened rather than after everything else.
        at: runStore.events.length,
      });
      runStore.state = "awaiting";
      return;
    case "permission.decided": {
      // A check that opened a card resolves that card; one settled by a rule or
      // the unmatched policy never paused the run, so it lands in the stream.
      const rec = runStore.permissions.find((p) => p.id === ev.id);
      if (!rec) {
        runStore.events.push(ev);
        return;
      }
      rec.decided = { allow: ev.allow, message: ev.message ?? null };
      runStore.state = "running";
      return;
    }
    default:
      runStore.events.push(ev); // streaming row
      return;
  }
  const terminal = terminalStateFor(ev);
  if (terminal) {
    runStore.state = terminal;
    teardown();
  }
}

export async function startRun(spec: RunSpec) {
  if (runStore.state === "running" || runStore.state === "awaiting") return;
  teardown();
  runStore.events = [];
  runStore.summary = null;
  runStore.asks = [];
  runStore.permissions = [];
  runStore.state = "running";
  unlisten = await api.onRunEvent(handle);
  try {
    await api.runSpec(spec);
  } catch (e) {
    runStore.events.push({ type: "log", level: "error", message: `run failed: ${e}` });
    runStore.state = "error";
    teardown();
  }
}

export async function cancelRun() {
  if (runStore.state !== "running" && runStore.state !== "awaiting") return;
  await api.cancelRun();
  runStore.events.push({
    type: "log",
    level: "warn",
    message: "run cancelled — engine stopped claude and cleaned up the plugin-dir",
  });
  runStore.state = "warning";
  teardown();
}

export async function submitAnswer(id: string, answers: string[][]) {
  if (runStore.state !== "awaiting") return;
  await api.submitAnswer(id, answers);
  // optimistic; the engine's ask.answered will set the record's answers and flip state back to running
}

export async function submitDecision(id: string, allow: boolean, message: string | null) {
  if (runStore.state !== "awaiting") return;
  await api.submitDecision(id, allow, message);
  // optimistic; the engine's permission.decided resolves the card and resumes the run
}

/* Run state store. Holds the observe-pane state machine and event buffer, and
 * drives the run via the api bridge. Components read `runStore` reactively;
 * the bridge (Tauri or browser fallback) feeds events in. */
import type { RunSpec } from "../bindings/RunSpec";
import type { KataEvent, StreamEvent, RunSummary, RunState, Question } from "./events";
import { terminalStateFor } from "./events";
import * as api from "./api";

export const runStore = $state<{
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  pendingAsk: { id: string; questions: Question[] } | null;
}>({ state: "idle", events: [], summary: null, pendingAsk: null });

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
      runStore.pendingAsk = { id: ev.id, questions: ev.questions };
      runStore.state = "awaiting";
      return;
    case "ask.answered":
      runStore.pendingAsk = null;
      runStore.state = "running";
      return;
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
  runStore.pendingAsk = null;
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
  // optimistic; the engine's ask.answered will flip state back to running
}

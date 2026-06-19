import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { RunSpec } from "../bindings/RunSpec";
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { Preset } from "../bindings/Preset";
import type { KataEvent, RunRecord, RunDetail } from "$lib/events";
import { inTauri, seedCatalog, validateLocal, runScriptHead, runScriptTail } from "$lib/mock";
import { history as historyFixture, runDetailFixture, katasFixture, presetsFixture } from "$lib/library";

export const catalog = (workdir: string | null) =>
  inTauri()
    ? invoke<CatalogEntry[]>("catalog", { workdir })
    : Promise.resolve(seedCatalog);

export const listRuns = (): Promise<RunRecord[]> =>
  inTauri() ? invoke<RunRecord[]>("list_runs") : Promise.resolve(historyFixture);

export const loadRun = (id: string): Promise<RunDetail> =>
  inTauri() ? invoke<RunDetail>("load_run", { id }) : Promise.resolve(runDetailFixture(id));

const NO_BACKEND = "this action needs the Kata desktop app (Tauri backend unavailable)";

export const loadSpec = (path: string) =>
  inTauri()
    ? invoke<RunSpec>("load_spec", { path })
    : Promise.reject(new Error(NO_BACKEND));

export const saveSpec = (path: string, spec: RunSpec) =>
  inTauri()
    ? invoke<void>("save_spec", { path, spec })
    : Promise.reject(new Error(NO_BACKEND));

export const validateSpec = (spec: RunSpec) =>
  inTauri()
    ? invoke<string[]>("validate_spec", { spec })
    : Promise.resolve(validateLocal(spec));

/* ---------------- Run bridge ----------------
 * Real app: the Rust backend spawns the engine and relays its JSON-lines as
 * `kata://event`; we listen and forward. Browser dev: a scripted timeline
 * stands in (see runScript in mock.ts). The frontend stays presentational —
 * it only subscribes and renders. */

let browserCb: ((ev: KataEvent) => void) | null = null;
let browserTimers: ReturnType<typeof setTimeout>[] = [];

/** Subscribe to relayed run events. Returns an unsubscribe function. */
export async function onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void> {
  if (inTauri()) return listen<KataEvent>("kata://event", (e) => cb(e.payload));
  browserCb = cb;
  return () => {
    if (browserCb === cb) browserCb = null;
  };
}

/** Start a run for the given spec. Events arrive via onRunEvent. */
export async function runSpec(spec: RunSpec): Promise<void> {
  if (inTauri()) return invoke<void>("run_spec", { spec });
  let acc = 0;
  for (const step of runScriptHead) {
    acc += step.delay;
    browserTimers.push(setTimeout(() => browserCb?.(step.ev), acc));
  }
}

/** Cancel the in-flight run (stops the backend/scripted stream). */
export async function cancelRun(): Promise<void> {
  if (inTauri()) return invoke<void>("cancel_run");
  browserTimers.forEach(clearTimeout);
  browserTimers = [];
}

/** Send the operator's answer to a pending ask.requested. */
export async function submitAnswer(id: string, answers: string[][]): Promise<void> {
  if (inTauri()) return invoke<void>("submit_answer", { id, answers });
  // Browser mock: resolve the scripted pause by feeding an ask.answered + resume.
  browserCb?.({ type: "ask.answered", id, answers });
  resumeMockAfterAnswer();
}

/** Resume the scripted mock timeline after an ask has been answered. */
function resumeMockAfterAnswer(): void {
  let acc = 0;
  for (const step of runScriptTail) {
    acc += step.delay;
    browserTimers.push(setTimeout(() => browserCb?.(step.ev), acc));
  }
}

export const listKatas = (): Promise<RunSpec[]> =>
  inTauri() ? invoke<RunSpec[]>("list_katas") : Promise.resolve(katasFixture);

export const loadKata = (name: string): Promise<RunSpec> =>
  inTauri() ? invoke<RunSpec>("load_kata", { name }) : Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]);

export const saveKata = (spec: RunSpec): Promise<void> =>
  inTauri() ? invoke<void>("save_kata", { spec }) : Promise.resolve();

export const listPresets = (): Promise<Preset[]> =>
  inTauri() ? invoke<Preset[]>("list_presets") : Promise.resolve(presetsFixture);

export const savePreset = (name: string, body: string): Promise<void> =>
  inTauri() ? invoke<void>("save_preset", { name, body }) : Promise.resolve();

export const exportBundle = (spec: RunSpec, out: string): Promise<void> =>
  inTauri() ? invoke<void>("export_bundle", { spec, out }) : Promise.reject(new Error(NO_BACKEND));

const SPEC_FILTERS = [{ name: "Run-spec", extensions: ["toml", "json"] }];

// Native file dialogs only exist under Tauri; in a plain browser these are
// no-ops (return null) so Open/Save/Browse stay safe.
export const pickDirectory = (): Promise<string | null> =>
  inTauri() ? (open({ directory: true, multiple: false }) as Promise<string | null>) : Promise.resolve(null);

export const pickOpenSpec = (): Promise<string | null> =>
  inTauri() ? (open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>) : Promise.resolve(null);

export const pickSaveSpec = (): Promise<string | null> =>
  inTauri() ? (save({ filters: SPEC_FILTERS }) as Promise<string | null>) : Promise.resolve(null);

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { RunSpec } from "../bindings/RunSpec";
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { KataEvent } from "$lib/events";
import { inTauri, seedCatalog, validateLocal, runScript } from "$lib/mock";

export const catalog = (workdir: string | null) =>
  inTauri()
    ? invoke<CatalogEntry[]>("catalog", { workdir })
    : Promise.resolve(seedCatalog);

export const loadSpec = (path: string) =>
  invoke<RunSpec>("load_spec", { path });

export const saveSpec = (path: string, spec: RunSpec) =>
  invoke<void>("save_spec", { path, spec });

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
  for (const step of runScript) {
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

const SPEC_FILTERS = [{ name: "Run-spec", extensions: ["toml", "json"] }];

export const pickDirectory = () =>
  open({ directory: true, multiple: false }) as Promise<string | null>;

export const pickOpenSpec = () =>
  open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>;

export const pickSaveSpec = () =>
  save({ filters: SPEC_FILTERS }) as Promise<string | null>;

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { RunSpec } from "../bindings/RunSpec";
import type { CatalogEntry } from "../bindings/CatalogEntry";

export const catalog = (workdir: string | null) =>
  invoke<CatalogEntry[]>("catalog", { workdir });

export const loadSpec = (path: string) =>
  invoke<RunSpec>("load_spec", { path });

export const saveSpec = (path: string, spec: RunSpec) =>
  invoke<void>("save_spec", { path, spec });

export const validateSpec = (spec: RunSpec) =>
  invoke<string[]>("validate_spec", { spec });

const SPEC_FILTERS = [{ name: "Run-spec", extensions: ["toml", "json"] }];

export const pickDirectory = () =>
  open({ directory: true, multiple: false }) as Promise<string | null>;

export const pickOpenSpec = () =>
  open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>;

export const pickSaveSpec = () =>
  save({ filters: SPEC_FILTERS }) as Promise<string | null>;

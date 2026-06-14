<script lang="ts">
  import type { RunSpec } from "../bindings/RunSpec";
  import type { CatalogEntry } from "../bindings/CatalogEntry";
  import { defaultSpec, normalize, specEquals } from "$lib/spec";
  import * as api from "$lib/api";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import ValidationBanner from "$lib/components/ValidationBanner.svelte";
  import ComposePane from "$lib/components/ComposePane.svelte";

  let spec = $state<RunSpec>(defaultSpec());
  let saved = $state<RunSpec>(defaultSpec()); // last-saved snapshot for dirty tracking
  let currentPath = $state<string | null>(null);
  let entries = $state<CatalogEntry[]>([]);
  let errors = $state<string[]>([]);

  let dirty = $derived(!specEquals(spec, saved));

  // Re-fetch the kit when workdir changes (debounced).
  $effect(() => {
    const workdir = spec.workdir;
    const t = setTimeout(async () => {
      try {
        entries = await api.catalog(workdir.trim() === "" ? null : workdir);
      } catch (e) {
        console.error("catalog failed", e);
        entries = [];
      }
    }, 300);
    return () => clearTimeout(t);
  });

  // Live validation (debounced).
  $effect(() => {
    const snapshot = $state.snapshot(spec) as RunSpec;
    const t = setTimeout(async () => {
      try {
        errors = await api.validateSpec(normalize(snapshot));
      } catch (e) {
        console.error("validate failed", e);
        errors = [];
      }
    }, 200);
    return () => clearTimeout(t);
  });

  function confirmDiscard(): boolean {
    return !dirty || confirm("Discard unsaved changes?");
  }

  function onNew() {
    if (!confirmDiscard()) return;
    spec = defaultSpec();
    saved = $state.snapshot(spec) as RunSpec;
    currentPath = null;
  }

  async function onOpen() {
    if (!confirmDiscard()) return;
    const path = await api.pickOpenSpec();
    if (!path) return;
    try {
      const loaded = await api.loadSpec(path);
      spec = loaded;
      saved = $state.snapshot(spec) as RunSpec;
      currentPath = path;
    } catch (e) {
      alert(`Failed to load spec: ${e}`);
    }
  }

  async function writeTo(path: string) {
    try {
      await api.saveSpec(path, normalize($state.snapshot(spec) as RunSpec));
      currentPath = path;
      saved = $state.snapshot(spec) as RunSpec;
    } catch (e) {
      alert(`Failed to save spec: ${e}`);
    }
  }

  async function onSave() {
    if (currentPath) return writeTo(currentPath);
    return onSaveAs();
  }

  async function onSaveAs() {
    const path = await api.pickSaveSpec();
    if (path) await writeTo(path);
  }

  async function onPickWorkdir() {
    const dir = await api.pickDirectory();
    if (dir) spec.workdir = dir;
  }
</script>

<main>
  <Toolbar bind:name={spec.name} {dirty} {onNew} {onOpen} {onSave} {onSaveAs} />
  <ValidationBanner {errors} />
  <div class="panes">
    <section class="left">
      <ComposePane {spec} {entries} {onPickWorkdir} />
    </section>
    <section class="right">
      <p class="placeholder">Observe pane — M6</p>
    </section>
  </div>
</main>

<style>
  main { display: flex; flex-direction: column; height: 100vh; font-family: system-ui, sans-serif; }
  .panes { flex: 1; display: flex; min-height: 0; }
  .left { flex: 1; min-width: 0; border-right: 1px solid #ccc; display: flex; }
  .right { width: 320px; display: flex; align-items: center; justify-content: center; }
  .placeholder { color: #aaa; }
</style>

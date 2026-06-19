<script lang="ts">
  import type { RunSpec } from "../bindings/RunSpec";
  import type { CatalogEntry } from "../bindings/CatalogEntry";
  import type { Preset } from "../bindings/Preset";
  import { defaultSpec, normalize, specEquals, draftFrom } from "$lib/spec";
  import { inTauri, seedSpec } from "$lib/mock";
  import * as api from "$lib/api";
  import { takeLaunch } from "$lib/launch";
  import { onMount } from "svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import ValidationBanner from "$lib/components/ValidationBanner.svelte";
  import ComposePane from "$lib/components/ComposePane.svelte";
  import ObservePane from "$lib/components/ObservePane.svelte";
  import { runStore, startRun, cancelRun, submitAnswer } from "$lib/run.svelte";
  import { toastError } from "$lib/toast.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import Terminal from "@lucide/svelte/icons/terminal";
  import Hash from "@lucide/svelte/icons/hash";
  import Folder from "@lucide/svelte/icons/folder";
  import CheckCircle from "@lucide/svelte/icons/check-circle";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";

  // Real Tauri app opens a blank New spec; browser dev/review seeds the example.
  const initial = inTauri() ? defaultSpec() : seedSpec();
  let spec = $state<RunSpec>(structuredClone(initial));
  let saved = $state<RunSpec>(structuredClone(initial)); // last-saved snapshot for dirty tracking
  let currentPath = $state<string | null>(null);
  let entries = $state<CatalogEntry[]>([]);
  let errors = $state<string[]>([]);
  let presets = $state<Preset[]>([]);

  let dirty = $derived(!specEquals(spec, saved));
  let valid = $derived(errors.length === 0);
  let running = $derived(runStore.state === "running" || runStore.state === "awaiting");

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

  let confirmDiscardState = $state<{ action: () => void | Promise<void> } | null>(null);

  // Run `action` immediately when there are no unsaved changes; otherwise defer
  // it behind a confirm dialog.
  function guardDiscard(action: () => void | Promise<void>) {
    if (!dirty) { void action(); return; }
    confirmDiscardState = { action };
  }

  function onNew() {
    guardDiscard(() => {
      spec = defaultSpec();
      saved = $state.snapshot(spec) as RunSpec;
      currentPath = null;
    });
  }

  function onOpen() {
    guardDiscard(async () => {
      const path = await api.pickOpenSpec();
      if (!path) return;
      try {
        const loaded = await api.loadSpec(path);
        spec = draftFrom(loaded);
        saved = $state.snapshot(spec) as RunSpec;
        currentPath = path;
      } catch (e) {
        toastError(`Failed to load spec: ${e}`);
      }
    });
  }

  async function onSave() {
    try {
      await api.saveKata(normalize($state.snapshot(spec) as RunSpec));
      saved = $state.snapshot(spec) as RunSpec;
    } catch (e) {
      toastError(`Failed to save kata: ${e}`);
    }
  }

  async function onExport() {
    const dir = await api.pickDirectory();
    if (!dir) return;
    try {
      await api.exportBundle(normalize($state.snapshot(spec) as RunSpec), dir);
    } catch (e) {
      toastError(`Failed to export bundle: ${e}`);
    }
  }

  async function onPickWorkdir() {
    const dir = await api.pickDirectory();
    if (dir) spec.workdir = dir;
  }

  // Run / Cancel — driven through the run store + Tauri event bridge.
  function onRun() {
    if (!valid || running) return;
    startRun(normalize($state.snapshot(spec) as RunSpec));
  }
  function onCancel() {
    cancelRun();
  }

  async function onSavePreset(name: string, body: string) {
    try { await api.savePreset(name, body); presets = await api.listPresets(); }
    catch (e) { toastError(`Failed to save preset: ${e}`); }
  }

  // Browser dev/review only: `?demo=run` auto-starts the scripted run so the
  // Observe pane can be reviewed/screenshotted without a click. Never fires in
  // the real Tauri app.
  onMount(async () => {
    try { presets = await api.listPresets(); } catch (e) { console.error("listPresets failed", e); presets = []; }
    if (!inTauri() && new URLSearchParams(location.search).get("demo") === "run") onRun();
    const handoff = takeLaunch();
    if (handoff) {
      spec = draftFrom(handoff.spec);
      saved = $state.snapshot(spec) as RunSpec;
      currentPath = null;
      if (handoff.autorun) {
        const errs = await api.validateSpec(normalize($state.snapshot(spec) as RunSpec));
        if (errs.length === 0) startRun(normalize($state.snapshot(spec) as RunSpec));
      }
    }
  });

  // Ctrl+↵ (or ⌘↵) to run.
  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!running) onRun();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="wb">
  <Toolbar
    bind:name={spec.name}
    {dirty}
    {running}
    canRun={valid}
    {onNew}
    {onOpen}
    {onSave}
    {onExport}
    {onRun}
    {onCancel}
  />

  <ValidationBanner {errors} />

  <div class="wb-panes">
    <div class="wb-pane wb-pane--compose">
      <div class="wb-pane__head"><span class="kata-eyebrow">Compose · the run-spec</span></div>
      <div class="wb-pane__body">
        <ComposePane {spec} {entries} {onPickWorkdir} {presets} {onSavePreset} />
      </div>
    </div>

    <div class="wb-pane wb-pane--observe">
      <div class="wb-pane__head"><span class="kata-eyebrow">Observe · the run</span></div>
      <ObservePane runState={runStore.state} events={runStore.events} {spec} summary={runStore.summary} asks={runStore.asks} onAnswer={submitAnswer} />
    </div>
  </div>

  <footer class="wb-statusbar">
    <span class="wb-statusbar__item" class:wb-statusbar__ok={valid} class:wb-statusbar__err={!valid}>
      {#if valid}
        <CheckCircle size={13} /> spec is valid
      {:else}
        <AlertTriangle size={13} /> {errors.length} {errors.length === 1 ? "error" : "errors"}: {errors[0]}
      {/if}
    </span>
    <div class="wb-statusbar__spacer"></div>
    <span class="wb-statusbar__item"><Hash size={13} /> schema {spec.schema}</span>
    <span class="wb-statusbar__item"><Folder size={13} /> {spec.workdir || "—"}</span>
    <span class="wb-statusbar__item"><Terminal size={13} /> claude --bare -p</span>
  </footer>

  {#if confirmDiscardState}
    <ConfirmDialog
      message="Discard unsaved changes?"
      confirmLabel="Discard"
      onConfirm={() => { const a = confirmDiscardState!.action; confirmDiscardState = null; void a(); }}
      onCancel={() => (confirmDiscardState = null)}
    />
  {/if}
</div>

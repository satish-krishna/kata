<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { CatalogEntry } from "../../bindings/CatalogEntry";
  import KitChecklist from "./KitChecklist.svelte";

  let {
    spec,
    entries,
    onPickWorkdir,
  }: { spec: RunSpec; entries: CatalogEntry[]; onPickWorkdir: () => void } = $props();
</script>

<div class="compose">
  <label>Description<input bind:value={spec.description} /></label>

  <label>Task<textarea rows="4" bind:value={spec.task}></textarea></label>
  <label>Context<textarea rows="3" bind:value={spec.context}></textarea></label>

  <label>Workdir
    <span class="picker">
      <input bind:value={spec.workdir} />
      <button onclick={onPickWorkdir}>Browse…</button>
    </span>
  </label>

  <fieldset>
    <legend>Identity</legend>
    <label>System prompt<textarea rows="3" bind:value={spec.identity.system_prompt}></textarea></label>
    <label>Mode
      <select bind:value={spec.identity.mode}>
        <option value="append">append</option>
        <option value="replace">replace</option>
      </select>
    </label>
  </fieldset>

  <fieldset>
    <legend>Kit</legend>
    <KitChecklist {spec} {entries} />
  </fieldset>

  <label>Model id<input placeholder="(default)" bind:value={spec.model.id} /></label>

  <fieldset>
    <legend>Leash</legend>
    <label>Max turns<input type="number" min="1" step="1" bind:value={spec.leash.max_turns} /></label>
    <label>Timeout (secs, optional)
      <input type="number" min="0" step="1"
        value={spec.leash.timeout_secs ?? ""}
        oninput={(e) => (spec.leash.timeout_secs = e.currentTarget.value === "" ? null : Number(e.currentTarget.value))} />
    </label>
    <label>Isolation
      <select bind:value={spec.leash.isolation}>
        <option value="none">none</option>
        <option value="worktree">worktree</option>
      </select>
    </label>
  </fieldset>
</div>

<style>
  .compose { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; overflow-y: auto; }
  label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
  fieldset { display: flex; flex-direction: column; gap: 0.5rem; }
  legend { font-weight: 600; }
  .picker { display: flex; gap: 0.5rem; }
  .picker input { flex: 1; }
  input, textarea, select { font: inherit; padding: 0.3rem; }
</style>

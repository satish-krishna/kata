<script lang="ts">
  let {
    name = $bindable(),
    dirty,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
  }: {
    name: string;
    dirty: boolean;
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
  } = $props();
</script>

<header class="toolbar">
  <input class="spec-name" placeholder="spec name" bind:value={name} />
  <span class="dirty" class:on={dirty}>{dirty ? "● unsaved" : "saved"}</span>
  <div class="spacer"></div>
  <button onclick={onNew}>New</button>
  <button onclick={onOpen}>Open</button>
  <button onclick={onSave}>Save</button>
  <button onclick={onSaveAs}>Save As</button>
  <button disabled title="Coming in M7">Export bundle</button>
  <button disabled title="Coming in M6">Run</button>
</header>

<style>
  .toolbar { display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; border-bottom: 1px solid #ccc; }
  .spec-name { font-weight: 600; padding: 0.25rem 0.5rem; }
  .spacer { flex: 1; }
  .dirty { font-size: 0.8rem; color: #888; }
  .dirty.on { color: #c60; }
</style>

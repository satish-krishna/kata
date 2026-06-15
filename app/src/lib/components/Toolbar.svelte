<script lang="ts">
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Save from "@lucide/svelte/icons/save";
  import Package from "@lucide/svelte/icons/package";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";

  let {
    name = $bindable(),
    dirty,
    running = false,
    canRun = true,
    onNew,
    onOpen,
    onSave,
    onExport,
    onRun,
    onCancel,
  }: {
    name: string;
    dirty: boolean;
    running?: boolean;
    canRun?: boolean;
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onExport?: () => void;
    onRun?: () => void;
    onCancel?: () => void;
  } = $props();
</script>

<header class="wb-toolbar">
  <div class="wb-brand">
    <span class="wb-seal">型</span>
  </div>
  <div class="wb-sep"></div>
  <div class="wb-spec">
    <input class="wb-specname" placeholder="spec name" bind:value={name} aria-label="Spec name" />
    <span class="wb-dirty" class:wb-dirty--on={dirty}>
      {#if dirty}<span class="wb-dirty__dot"></span>unsaved{:else}saved{/if}
    </span>
  </div>
  <div class="wb-toolbar__spacer"></div>
  <div class="wb-toolbar__group">
    <button class="k-iconbtn" onclick={onNew} title="New" aria-label="New spec"><FilePlus size={16} /></button>
    <button class="k-iconbtn" onclick={onOpen} title="Open" aria-label="Open spec"><FolderOpen size={16} /></button>
    <button class="k-iconbtn" onclick={onSave} title="Save  Ctrl+S" aria-label="Save spec"><Save size={16} /></button>
    <button class="k-iconbtn" onclick={onExport} disabled={!onExport} title="Export bundle" aria-label="Export bundle"><Package size={16} /></button>
  </div>
  <div class="wb-sep"></div>
  {#if running}
    <button class="k-btn k-btn--danger" onclick={onCancel}>
      <Square size={14} />Cancel
    </button>
  {:else}
    <button class="k-btn k-btn--primary" onclick={onRun} disabled={!canRun}>
      <Play size={14} />Run<span class="k-kbd">Ctrl ↵</span>
    </button>
  {/if}
</header>

<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  let { task, onRun, onCancel }: { task: string; onRun: (task: string) => void; onCancel: () => void } = $props();
  let draft = $state(task);
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && draft.trim()) onRun(draft);
  }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label="Re-run with a new task" tabindex="-1" onkeydown={key}>
  <div class="k-dialog__head">Re-run · new task</div>
  <textarea class="k-textarea" rows="4" bind:value={draft} aria-label="Task"></textarea>
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={() => onRun(draft)} disabled={!draft.trim()}><Play size={13} />Run</button>
  </div>
</div>

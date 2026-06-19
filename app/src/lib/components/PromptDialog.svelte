<script lang="ts">
  let { title, initial = "", placeholder = "", onConfirm, onCancel }:
    { title: string; initial?: string; placeholder?: string; onConfirm: (value: string) => void; onCancel: () => void } = $props();
  let draft = $state(initial);
  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && draft.trim()) onConfirm(draft.trim());
  }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={key}>
  <div class="k-dialog__head">{title}</div>
  <input class="k-input" {placeholder} bind:value={draft} aria-label={title} />
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={() => onConfirm(draft.trim())} disabled={!draft.trim()}>Save</button>
  </div>
</div>

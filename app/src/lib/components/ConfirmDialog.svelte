<script lang="ts">
  let { message, confirmLabel = "Confirm", onConfirm, onCancel }:
    { message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void } = $props();
  function key(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
</script>

<div class="k-dialog__scrim" role="presentation" onclick={onCancel}></div>
<div class="k-dialog" role="dialog" aria-modal="true" aria-label={message} tabindex="-1" onkeydown={key}>
  <div class="k-dialog__head">{message}</div>
  <div class="k-dialog__actions">
    <button class="k-btn k-btn--ghost k-btn--sm" onclick={onCancel}>Cancel</button>
    <button class="k-btn k-btn--primary k-btn--sm" onclick={onConfirm}>{confirmLabel}</button>
  </div>
</div>

<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Package from "@lucide/svelte/icons/package";

  // A run's kata can be deleted (or never saved) while its history entry lives
  // on, so all three actions need the kata to still exist. When it doesn't, the
  // buttons disable and a title explains why rather than failing silently.
  let {
    kataSaved,
    onReRun,
    onOpenInCompose,
    onExportBundle,
  }: {
    kataSaved: boolean;
    onReRun: () => void;
    onOpenInCompose: () => void;
    onExportBundle: () => void;
  } = $props();

  const MISSING_KATA_HINT =
    "This run's kata is not in the library — save or recreate it to re-run, open in compose, or export.";
  let hint = $derived(kataSaved ? undefined : MISSING_KATA_HINT);
</script>

<!-- The hint lives on the container, not the buttons: a disabled <button> doesn't
     fire pointer events, so a title on it never shows on hover. The wrapper is
     always hoverable, and the disabled buttons let the hover fall through to it. -->
<div class="wb-detail__actions" title={hint}>
  <button class="k-btn k-btn--primary k-btn--sm" disabled={!kataSaved} onclick={onReRun}><Play size={13} />Re-run</button>
  <button class="k-btn k-btn--secondary k-btn--sm" disabled={!kataSaved} onclick={onOpenInCompose}><FolderOpen size={14} />Open in compose</button>
  <button class="k-btn k-btn--ghost k-btn--sm" disabled={!kataSaved} onclick={onExportBundle}><Package size={14} />Export bundle</button>
</div>

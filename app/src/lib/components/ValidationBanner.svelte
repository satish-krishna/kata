<script lang="ts">
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";

  let { errors }: { errors: string[] } = $props();
</script>

{#if errors.length > 0}
  <div class="wb-banner wb-banner--error" role="alert">
    <AlertTriangle size={15} />
    <div class="wb-banner__list">
      {#each errors as e}<span>{e}</span>{/each}
    </div>
  </div>
{/if}

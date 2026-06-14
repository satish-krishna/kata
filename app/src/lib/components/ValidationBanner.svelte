<script lang="ts">
  let { errors }: { errors: string[] } = $props();
</script>

{#if errors.length > 0}
  <ul class="banner">
    {#each errors as e}
      <li>{e}</li>
    {/each}
  </ul>
{:else}
  <p class="ok">Spec is valid.</p>
{/if}

<style>
  .banner { margin: 0.5rem; padding: 0.5rem 1rem; background: #fdecea; border: 1px solid #f5c6cb; color: #842029; border-radius: 4px; }
  .ok { margin: 0.5rem; padding: 0.5rem 1rem; color: #0a7d28; font-size: 0.85rem; }
</style>

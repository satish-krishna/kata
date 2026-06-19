<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { toasts, dismiss } from "$lib/toast";
</script>

{#if toasts().length > 0}
  <div class="k-toaster">
    {#each toasts() as t (t.id)}
      <div class="k-toast k-toast--{t.kind}" role="alert">
        <span class="k-toast__dot"></span>
        <span class="k-toast__msg">{t.message}</span>
        <button class="k-toast__close" aria-label="Dismiss" onclick={() => dismiss(t.id)}><X size={14} /></button>
      </div>
    {/each}
  </div>
{/if}

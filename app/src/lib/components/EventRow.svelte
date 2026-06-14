<script lang="ts">
  import type { StreamEvent } from "../events";
  import { gutterFor, variantFor, bodyFor } from "../events";

  let { ev }: { ev: StreamEvent } = $props();

  let tool = $derived(ev.type === "tool.use" || ev.type === "tool.result" ? ev.name : null);
</script>

<div class="k-event k-event--{variantFor(ev)}">
  <span class="k-event__gutter">{gutterFor(ev)}</span>
  <span class="k-event__body">
    {#if ev.type === "turn"}
      <span style="display:block;border-top:1px dashed var(--border-subtle);margin-top:6px"></span>
    {:else}
      {#if tool}<span class="k-event__tool">{tool}</span>{" "}{/if}{bodyFor(ev)}
    {/if}
  </span>
</div>

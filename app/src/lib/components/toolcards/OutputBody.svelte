<script lang="ts">
  let { text, truncated = false }: { text: string; truncated?: boolean } = $props();
</script>

<pre class="k-toolcard__out">{text || "(no output)"}</pre>
{#if truncated}<div class="k-toolcard__trunc">… truncated at 256 KB</div>{/if}

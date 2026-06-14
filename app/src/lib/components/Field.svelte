<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    key,
    hint,
    error = false,
    children,
  }: {
    label: string;
    /** The literal spec key, shown in mono beside the label. */
    key?: string;
    hint?: string;
    error?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="k-field">
  <div class="k-field__label">
    {label}
    {#if key}<code>{key}</code>{/if}
  </div>
  {@render children()}
  {#if hint}
    <div class="k-field__hint" class:k-field__hint--error={error}>{hint}</div>
  {/if}
</div>

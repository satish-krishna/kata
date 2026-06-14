<script lang="ts" generics="T extends string">
  let {
    options,
    value = $bindable(),
    ariaLabel,
  }: {
    options: readonly T[];
    value: T;
    ariaLabel?: string;
  } = $props();
</script>

<div class="k-seg" role="radiogroup" aria-label={ariaLabel}>
  {#each options as opt (opt)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt}
      class="k-seg__opt"
      class:k-seg__opt--active={value === opt}
      onclick={() => (value = opt)}
    >
      {opt}
    </button>
  {/each}
</div>

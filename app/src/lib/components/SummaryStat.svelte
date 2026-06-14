<script lang="ts">
  let {
    label,
    value,
    tone,
  }: {
    label: string;
    value: string | number;
    tone?: "success" | "error";
  } = $props();
</script>

<div class="k-stat">
  <span class="k-stat__label">{label}</span>
  <span
    class="k-stat__value"
    class:k-stat__value--success={tone === "success"}
    class:k-stat__value--error={tone === "error"}
  >{value}</span>
</div>

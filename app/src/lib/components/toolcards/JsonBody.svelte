<script lang="ts">
  let { value }: { value: unknown } = $props();
</script>

<pre class="k-toolcard__out">{JSON.stringify(value, null, 2)}</pre>

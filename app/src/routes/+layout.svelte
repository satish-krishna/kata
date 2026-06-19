<script lang="ts">
  import "../styles/styles.css";
  import "../styles/workbench.css";
  import Toaster from "$lib/components/Toaster.svelte";
  let { children } = $props();
</script>

{@render children()}
<Toaster />

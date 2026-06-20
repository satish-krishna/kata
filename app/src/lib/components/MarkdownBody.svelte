<script lang="ts">
  import Markdown from "svelte-exmarkdown";
  import remarkGfm from "remark-gfm";

  let { md }: { md: string } = $props();

  // If the type checker rejects this form, see Risk R5 in the plan:
  // replace with [{ remarkPlugin: remarkGfm }]
  const plugins = [{ remarkPlugin: remarkGfm }];

  function handleClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    e.preventDefault();
    // Opens in system browser under both plain-browser and Tauri.
    // If Tauri navigates the webview instead, follow Risk R2 in the plan.
    window.open(href, "_blank", "noopener,noreferrer");
  }
</script>

<div class="k-md" role="presentation" onclick={handleClick}>
  <Markdown {md} {plugins} />
</div>

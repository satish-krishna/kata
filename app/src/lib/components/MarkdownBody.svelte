<script lang="ts">
  import Markdown from "svelte-exmarkdown";
  import remarkGfm from "remark-gfm";

  let { md }: { md: string } = $props();

  // If the type checker rejects this form, see Risk R5 in the plan:
  // replace with [{ remarkPlugin: remarkGfm }]
  const plugins = [{ remarkPlugin: remarkGfm }];

  function handleClick(e: MouseEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    e.preventDefault();
    // Resolve to validate the scheme — block javascript:, data:, etc. and
    // only open over safe protocols. Open the original href so the URL is
    // passed through verbatim (no normalisation surprises).
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
      return;
    }
    // Opens in system browser under both plain-browser and Tauri.
    // If Tauri navigates the webview instead, follow Risk R2 in the plan.
    window.open(href, "_blank", "noopener,noreferrer");
  }
</script>

<!--
  Click handler is event delegation for the rendered markdown's own links,
  which are independently keyboard-accessible — the div is not itself an
  interactive widget, so no role or key handler belongs on it.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="k-md" onclick={handleClick}>
  <Markdown {md} {plugins} />
</div>

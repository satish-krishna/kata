<script lang="ts">
  import { diffLines } from "diff";
  import { DIFF_TIMEOUT_MS } from "$lib/toolcards";
  import OutputBody from "./OutputBody.svelte";

  let { oldText, newText }: { oldText: string; newText: string } = $props();

  type Line = { kind: "add" | "del" | "ctx"; text: string };
  /* No line numbers: an Edit's input carries no position in the file. `null`
     when the diff timed out; the template then shows the two texts as-is. */
  const lines: Line[] | null = $derived.by(() => {
    const parts = diffLines(oldText, newText, { timeout: DIFF_TIMEOUT_MS });
    if (!parts) return null;
    return parts.flatMap((part) => {
      const kind = part.added ? "add" : part.removed ? "del" : "ctx";
      return part.value.replace(/\n$/, "").split("\n").map((text): Line => ({ kind, text }));
    });
  });
  const MARK = { add: "+", del: "-", ctx: " " } as const;
</script>

{#if lines}
  <div class="k-toolcard__diff">
    {#each lines as l, i (i)}
      <div class="k-toolcard__dl k-toolcard__dl--{l.kind}"><span class="k-toolcard__dm">{MARK[l.kind]}</span>{l.text}</div>
    {/each}
  </div>
{:else}
  <div class="k-toolcard__label">before</div>
  <OutputBody text={oldText} />
  <div class="k-toolcard__label">after</div>
  <OutputBody text={newText} />
{/if}

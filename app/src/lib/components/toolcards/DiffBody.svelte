<script lang="ts">
  import { diffLines } from "diff";

  let { oldText, newText }: { oldText: string; newText: string } = $props();

  type Line = { kind: "add" | "del" | "ctx"; text: string };
  /* No line numbers: an Edit's input carries no position in the file. */
  const lines: Line[] = $derived(
    diffLines(oldText, newText).flatMap((part) => {
      const kind = part.added ? "add" : part.removed ? "del" : "ctx";
      return part.value.replace(/\n$/, "").split("\n").map((text): Line => ({ kind, text }));
    }),
  );
  const MARK = { add: "+", del: "-", ctx: " " } as const;
</script>

<div class="k-toolcard__diff">
  {#each lines as l, i (i)}
    <div class="k-toolcard__dl k-toolcard__dl--{l.kind}"><span class="k-toolcard__dm">{MARK[l.kind]}</span>{l.text}</div>
  {/each}
</div>

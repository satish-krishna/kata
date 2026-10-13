<script lang="ts">
  import type { ToolCall } from "$lib/toolcards";
  import {
    rendererFor, statusOf, defaultOpen, targetFor, metaFor, inputOf, todosOf, editsOf, str, STATUS_TEXT,
  } from "$lib/toolcards";
  import EventRow from "./EventRow.svelte";
  import ToolCard from "./ToolCard.svelte";
  import DiffBody from "./toolcards/DiffBody.svelte";
  import TodoBody from "./toolcards/TodoBody.svelte";
  import OutputBody from "./toolcards/OutputBody.svelte";
  import JsonBody from "./toolcards/JsonBody.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let { call }: { call: ToolCall } = $props();

  const renderer = $derived(rendererFor(call));
  const status = $derived(statusOf(call));
  // null until the operator clicks: until then the default policy decides, so
  // a call that fails after it rendered (running → error) still opens itself.
  let toggled = $state<boolean | null>(null);
  const open = $derived(toggled ?? defaultOpen(call));
  const inp = $derived(inputOf(call));
  const meta = $derived(metaFor(call));
  const output = $derived(call.result ? (call.result.output ?? call.result.summary) : "");
  const outTruncated = $derived(call.result?.truncated ?? false);
  const edits = $derived(editsOf(call));
  // Bespoke bodies show the tool's own view; a failure's message goes under it.
  const showErrorOutput = $derived(
    status === "error" && (renderer === "edit" || renderer === "multiedit" || renderer === "write" || renderer === "todo"),
  );
</script>

<div class="k-toolcard">
  <button type="button" class="k-toolcard__row" aria-expanded={open} onclick={() => (toggled = !open)}>
    <span class="k-toolcard__chev">{#if open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</span>
    <span class="k-toolcard__dot k-toolcard__dot--{status}"></span>
    <span class="k-toolcard__name">{call.use.name}</span>
    <span class="k-toolcard__target">{targetFor(call)}</span>
    <span class="k-toolcard__meta">
      {#if meta.add !== undefined}<span class="k-toolcard__add">+{meta.add}</span>{/if}
      {#if meta.del !== undefined}<span class="k-toolcard__del">−{meta.del}</span>{/if}
      {#if meta.text}<span>{meta.text}</span>{/if}
    </span>
    <span class="k-toolcard__status k-toolcard__status--{status}">{STATUS_TEXT[status]}</span>
  </button>

  {#if open}
    <div class="k-toolcard__body">
      {#if renderer === "edit"}
        <DiffBody oldText={str(inp.old_string)} newText={str(inp.new_string)} />
      {:else if renderer === "multiedit"}
        {#each edits as e, i (i)}<DiffBody oldText={str(e.old_string)} newText={str(e.new_string)} />{/each}
      {:else if renderer === "write"}
        <DiffBody oldText="" newText={str(inp.content)} />
      {:else if renderer === "todo"}
        <TodoBody todos={todosOf(call)} />
      {:else if renderer === "agent"}
        {#if str(inp.prompt)}
          <div class="k-toolcard__label">prompt</div>
          <div class="k-toolcard__prose">{str(inp.prompt)}</div>
        {/if}
        {#each call.children as child (child.key)}
          {#if child.kind === "call"}<ToolCard call={child.call} />{:else}<EventRow ev={child.ev} />{/if}
        {/each}
        {#if call.result}
          <div class="k-toolcard__label">result</div>
          <OutputBody text={output} truncated={outTruncated} />
        {/if}
      {:else if renderer === "read" || renderer === "search"}
        <OutputBody text={output} truncated={outTruncated} />
      {:else}
        <div class="k-toolcard__label">input</div>
        {#if call.use.input != null}
          <JsonBody value={call.use.input} />
        {:else}
          <OutputBody text={call.use.input_summary} truncated={call.use.truncated ?? false} />
        {/if}
        {#if call.result}
          <div class="k-toolcard__label">output</div>
          <OutputBody text={output} truncated={outTruncated} />
        {/if}
      {/if}
      {#if showErrorOutput}
        <OutputBody text={output} truncated={outTruncated} />
      {/if}
    </div>
  {/if}
</div>

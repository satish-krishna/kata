<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { StreamEvent, RunSummary, RunState } from "../events";
  import { STATUS_LABEL } from "../events";
  import EventRow from "./EventRow.svelte";
  import SummaryStat from "./SummaryStat.svelte";
  import Cpu from "@lucide/svelte/icons/cpu";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Terminal from "@lucide/svelte/icons/terminal";
  import CheckCircle from "@lucide/svelte/icons/check-circle";
  import XCircle from "@lucide/svelte/icons/x-circle";

  let {
    runState,
    events,
    spec,
    summary,
  }: {
    runState: RunState;
    events: StreamEvent[];
    spec: RunSpec;
    summary: RunSummary | null;
  } = $props();

  let streamEl: HTMLDivElement | undefined = $state();

  // Keep the stream pinned to the latest event.
  $effect(() => {
    void events.length;
    void summary;
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  });

  const cost = (s: RunSummary) => (s.cost_usd != null ? `$${s.cost_usd.toFixed(3)}` : "—");
  const duration = (s: RunSummary) => `${(s.duration_ms / 1000).toFixed(1)}s`;
</script>

<div class="wb-status">
  <span class="k-status k-status--{runState}">
    <span class="k-status__dot"></span>{STATUS_LABEL[runState]}
  </span>
  <div class="wb-sep"></div>
  <div class="wb-status__meta"><Cpu size={14} /> {spec.model.id || "default"}</div>
  {#if spec.leash.isolation === "worktree"}
    <span class="k-badge k-badge--warning"><GitBranch size={11} /> worktree</span>
  {/if}
</div>

<div class="wb-stream" bind:this={streamEl}>
  {#if events.length === 0 && !summary}
    <div class="wb-stream__empty">
      <Terminal size={28} />
      <p>Press <b style="color:var(--accent-text)">Run</b> to drive <code>claude -p</code> to completion. The normalized event stream renders here.</p>
    </div>
  {:else}
    {#each events as ev, i (i)}
      <div class="wb-event-enter"><EventRow {ev} /></div>
    {/each}
  {/if}
</div>

{#if summary}
  <div class="wb-summary">
    <div class="wb-summary__head">
      {#if summary.is_error}
        <span class="k-badge k-badge--error"><XCircle size={12} /> run.completed</span>
      {:else}
        <span class="k-badge k-badge--success"><CheckCircle size={12} /> run.completed</span>
      {/if}
      <span style="font:var(--font-code-sm);color:var(--text-faint)">the form performed</span>
    </div>
    <div class="wb-summary__stats">
      <SummaryStat label="EXIT" value={summary.exit_code} tone={summary.is_error ? "error" : "success"} />
      <SummaryStat label="TURNS" value={summary.num_turns} />
      <SummaryStat label="COST" value={cost(summary)} />
      <SummaryStat label="DURATION" value={duration(summary)} />
    </div>
    {#if summary.result}
      <div class="wb-summary__result">{summary.result}</div>
    {/if}
  </div>
{/if}

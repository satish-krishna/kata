<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { StreamEvent, RunSummary, RunState } from "../events";
  import type { AskRecord, PermissionRecord } from "../run.svelte";
  import { STATUS_LABEL } from "../events";
  import EventRow from "./EventRow.svelte";
  import SummaryStat from "./SummaryStat.svelte";
  import AskPanel from "./AskPanel.svelte";
  import PermissionPanel from "./PermissionPanel.svelte";
  import MarkdownBody from "./MarkdownBody.svelte";
  import { isAtBottom } from "../scroll";
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
    asks = [],
    permissions = [],
    onAnswer,
    onDecide,
  }: {
    runState: RunState;
    events: StreamEvent[];
    spec: RunSpec;
    summary: RunSummary | null;
    asks?: AskRecord[];
    permissions?: PermissionRecord[];
    onAnswer?: (id: string, answers: string[][]) => void;
    onDecide?: (id: string, allow: boolean, message: string | null) => void;
  } = $props();

  let streamEl: HTMLDivElement | undefined = $state();
  // Follow the tail until the reader scrolls away. A plain (non-reactive) flag
  // on purpose: only appended content should trigger a scroll, never a change
  // to this flag — otherwise a pending ask would yank the reader back down.
  let stick = true;

  function onScroll() {
    if (streamEl) stick = isAtBottom(streamEl);
  }

  // Keep the stream pinned to the latest event, but only while the reader is
  // already at the bottom — so streaming events (or a pending ask) don't fight
  // them when they've scrolled up to read context.
  $effect(() => {
    void events.length;
    void summary;
    void asks.length;
    void permissions.length;
    if (streamEl && stick) streamEl.scrollTop = streamEl.scrollHeight;
  });

  /* A pause belongs where it happened, not in a pile at the end of the
   * transcript: reading "…ran the tests, then asked about this" is the whole
   * point of a stream. Every ask and permission record carries `at` — how many
   * events preceded it — and is spliced back in there.
   *
   * A run can only ever be paused on one thing at a time, so an ask and a
   * permission sharing an `at` is not a real sequence; permissions are emitted
   * first purely so the order is deterministic. */
  type StreamItem =
    | { kind: "event"; key: string; ev: StreamEvent }
    | { kind: "perm"; key: string; p: PermissionRecord }
    | { kind: "ask"; key: string; a: AskRecord };

  const streamItems: StreamItem[] = $derived.by(() => {
    const at = (n: number): StreamItem[] => [
      ...permissions
        .filter((p) => p.at === n)
        .map((p): StreamItem => ({ kind: "perm", key: `p:${p.id}`, p })),
      ...asks
        .filter((a) => a.at === n)
        .map((a): StreamItem => ({ kind: "ask", key: `a:${a.id}`, a })),
    ];
    const items: StreamItem[] = [...at(0)];
    events.forEach((ev, i) => {
      items.push({ kind: "event", key: `e:${i}`, ev });
      items.push(...at(i + 1));
    });
    // Defensive: never silently drop a pause whose position outran the stream.
    const beyond = (n: number) => n > events.length;
    items.push(
      ...permissions
        .filter((p) => beyond(p.at))
        .map((p): StreamItem => ({ kind: "perm", key: `p:${p.id}`, p })),
      ...asks
        .filter((a) => beyond(a.at))
        .map((a): StreamItem => ({ kind: "ask", key: `a:${a.id}`, a })),
    );
    return items;
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

<div class="wb-stream" bind:this={streamEl} onscroll={onScroll}>
  {#if events.length === 0 && !summary && asks.length === 0 && permissions.length === 0}
    <div class="wb-stream__empty">
      <Terminal size={28} />
      <p>Press <b style="color:var(--accent-text)">Run</b> to drive <code>claude -p</code> to completion. The normalized event stream renders here.</p>
    </div>
  {:else}
    {#each streamItems as item (item.key)}
      {#if item.kind === "event"}
        <div class="wb-event-enter"><EventRow ev={item.ev} /></div>
      {:else if item.kind === "perm" && item.p.decided === null}
        {#key item.p.id}
          <div class="wb-event-enter">
            <PermissionPanel
              id={item.p.id}
              tool={item.p.tool}
              input_summary={item.p.input_summary}
              onDecide={onDecide}
            />
          </div>
        {/key}
      {:else if item.kind === "perm"}
        <div class="wb-event-enter">
          <PermissionPanel
            id={item.p.id}
            tool={item.p.tool}
            input_summary={item.p.input_summary}
            decided={item.p.decided}
          />
        </div>
      {:else if item.a.answers === null}
        {#key item.a.id}
          <div class="wb-event-enter">
            <AskPanel id={item.a.id} questions={item.a.questions} onSubmit={onAnswer} />
          </div>
        {/key}
      {:else}
        <div class="wb-event-enter">
          <AskPanel id={item.a.id} questions={item.a.questions} answers={item.a.answers} />
        </div>
      {/if}
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
      <div class="wb-summary__result"><MarkdownBody md={summary.result} /></div>
    {/if}
  </div>
{/if}

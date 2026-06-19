<script lang="ts">
  import { savedKatas } from "$lib/library";
  import { listRuns, loadRun } from "$lib/api";
  import { statusForExit, isStreamEvent, type RunState, type RunRecord } from "$lib/events";
  import EventRow from "$lib/components/EventRow.svelte";
  import SummaryStat from "$lib/components/SummaryStat.svelte";
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Folder from "@lucide/svelte/icons/folder";
  import Search from "@lucide/svelte/icons/search";
  import Play from "@lucide/svelte/icons/play";
  import Package from "@lucide/svelte/icons/package";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Hash from "@lucide/svelte/icons/hash";
  import Clock from "@lucide/svelte/icons/clock";
  import Coins from "@lucide/svelte/icons/coins";
  import Cpu from "@lucide/svelte/icons/cpu";
  import Terminal from "@lucide/svelte/icons/terminal";
  import CheckCircle from "@lucide/svelte/icons/check-circle";

  let runs = $state<RunRecord[]>([]);
  let detail = $state<Awaited<ReturnType<typeof loadRun>> | null>(null);
  let selRun = $state<string | null>(null);
  let selKata = $state<string | null>(null);

  $effect(() => {
    listRuns().then((rs) => {
      runs = rs;
      if (selRun === null && rs.length > 0) selectRun(rs[0].id);
    });
  });

  let run = $derived(detail?.record ?? null);
  let stream = $derived(detail ? detail.events.filter(isStreamEvent) : null);

  const stateOf = (r: RunRecord): RunState => statusForExit(r.exit ?? null);
  const tone = (s: RunState) => (s === "success" ? "success" : s === "warning" ? "warning" : "error");
  const statTone = (s: RunState) => (s === "success" ? "success" : s === "error" ? "error" : undefined);
  const fmtMs = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const fmtCost = (c: number | null | undefined) => (c == null ? "—" : `$${c.toFixed(3)}`);
  const fmtTurns = (t: number | null | undefined) => (t == null ? "—" : `${t}`);
  const fmtWhen = (secs: number) => {
    const d = new Date(secs * 1000);
    const hh = `${d.getHours()}`.padStart(2, "0");
    const mm = `${d.getMinutes()}`.padStart(2, "0");
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
    const day = days === 0 ? "today" : days === 1 ? "yesterday"
      : days < 7 ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
      : d.toLocaleDateString();
    return `${day} · ${hh}:${mm}`;
  };

  async function selectRun(id: string) {
    selRun = id;
    const r = runs.find((x) => x.id === id);
    if (r) selKata = r.kata;
    detail = await loadRun(id);
  }
  function selectKata(name: string) {
    selKata = name;
    const latest = runs.find((r) => r.kata === name);
    if (latest) selectRun(latest.id);
    else { selRun = null; detail = null; }
  }
  const onKey = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  };
</script>

<div class="wb">
  <header class="wb-toolbar">
    <div class="wb-brand"><span class="wb-seal">型</span></div>
    <div class="wb-sep"></div>
    <span style="font:var(--weight-semibold) var(--text-md)/1 var(--font-sans);color:var(--text-primary)">Library</span>
    <div class="wb-toolbar__spacer"></div>
    <div class="wb-toolbar__group">
      <button class="k-iconbtn" aria-label="Search"><Search size={16} /></button>
      <button class="k-iconbtn" aria-label="Open"><FolderOpen size={16} /></button>
    </div>
    <div class="wb-sep"></div>
    <a href="/" class="k-btn k-btn--secondary"><Play size={14} />Open Workbench</a>
  </header>

  <div class="wb-panes">
    <aside class="wb-pane wb-pane--rail">
      <div class="wb-rail__head"><span class="kata-eyebrow">Library</span></div>
      <div class="wb-rail__newbtn">
        <a href="/" class="k-btn k-btn--primary k-btn--block"><FilePlus size={14} />New kata<span class="k-kbd">Ctrl N</span></a>
      </div>
      <div class="wb-pane__body">
        <div class="wb-rail__section">
          <div class="wb-rail__label">Saved katas<span class="wb-rail__count">{savedKatas.length}</span></div>
          {#each savedKatas as k (k.name)}
            <div
              class="wb-kata"
              class:wb-kata--active={selKata === k.name}
              role="button"
              tabindex="0"
              onclick={() => selectKata(k.name)}
              onkeydown={onKey(() => selectKata(k.name))}
            >
              <div class="wb-kata__top">
                <span class="wb-kata__name">{k.name}</span>
                <span class="wb-kata__dot dot-{k.lastState}"></span>
              </div>
              <div class="wb-kata__desc">{k.description}</div>
              <div class="wb-kata__meta">
                {#if k.isolation === "worktree"}<span><GitBranch />worktree</span>{/if}
                <span><Package />{k.skills + k.plugins} kit</span>
                <span><Hash />{k.runs} runs</span>
              </div>
            </div>
          {/each}
        </div>
        <div class="wb-rail__section">
          <div class="wb-rail__label">Recent runs<span class="wb-rail__count">{runs.length}</span></div>
          {#each runs as r (r.id)}
            <div
              class="wb-hist"
              class:wb-hist--active={selRun === r.id}
              role="button"
              tabindex="0"
              onclick={() => selectRun(r.id)}
              onkeydown={onKey(() => selectRun(r.id))}
            >
              <span class="wb-hist__dot dot-{stateOf(r)}"></span>
              <div class="wb-hist__body">
                <span class="wb-hist__kata">{r.kata}</span>
                <span class="wb-hist__when">{fmtWhen(r.started_at)} · {fmtTurns(r.turns)} turns · {fmtCost(r.cost_usd)}</span>
              </div>
              <span class="k-badge k-badge--{tone(stateOf(r))}">exit {r.exit ?? "—"}</span>
            </div>
          {/each}
        </div>
      </div>
    </aside>

    {#if run}
      <div class="wb-detail">
        <div class="wb-detail__head">
          <div class="wb-detail__title">
            <h2>{run.kata}</h2>
            <span class="wb-detail__id">{run.id}</span>
            <div style="margin-left:auto">
              <span class="k-status k-status--{stateOf(run)}"><span class="k-status__dot"></span>exit {run.exit ?? "—"}</span>
            </div>
          </div>
          <div class="wb-detail__sub">
            <span><Clock />{fmtWhen(run.started_at)}</span>
            <span><Hash />{fmtTurns(run.turns)} turns</span>
            <span><Coins />{fmtCost(run.cost_usd)}</span>
            <span><Cpu />{fmtMs(run.duration_ms)}</span>
          </div>
          <div class="wb-detail__actions">
            <button class="k-btn k-btn--primary k-btn--sm"><Play size={13} />Re-run</button>
            <a href="/" class="k-btn k-btn--secondary k-btn--sm"><FolderOpen size={14} />Open in compose</a>
            <button class="k-btn k-btn--ghost k-btn--sm"><Package size={14} />Export bundle</button>
          </div>
        </div>
        <div class="wb-detail__body">
          <div class="wb-detail__stats">
            <SummaryStat label="EXIT" value={run.exit ?? "—"} tone={statTone(stateOf(run))} />
            <SummaryStat label="TURNS" value={fmtTurns(run.turns)} />
            <SummaryStat label="COST" value={fmtCost(run.cost_usd)} />
            <SummaryStat label="DURATION" value={fmtMs(run.duration_ms)} />
          </div>
          <div class="wb-detail__result">{run.result ?? ""}</div>
          <div>
            <div class="wb-detail__streamhead" style="margin-bottom:10px">Event log · {run.kata}</div>
            {#if stream}
              <div class="wb-detail__stream">
                {#each stream as ev, i (i)}<EventRow {ev} />{/each}
              </div>
            {:else}
              <div class="wb-detail__result" style="color:var(--text-faint)">Event log for this run has been pruned from local history.</div>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="wb-detail" style="align-items:center;justify-content:center">
        <div class="wb-stream__empty">
          <Terminal size={28} />
          <p>Select a saved kata or a run from the rail to review its form and event log.</p>
        </div>
      </div>
    {/if}
  </div>

  <footer class="wb-statusbar">
    <span class="wb-statusbar__item wb-statusbar__ok">
      <CheckCircle size={13} /> {savedKatas.length} saved katas · {runs.length} runs in local history
    </span>
    <div class="wb-statusbar__spacer"></div>
    <span class="wb-statusbar__item"><Folder size={13} /> ~/.kata/runs</span>
  </footer>
</div>

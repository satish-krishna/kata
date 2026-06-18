<script lang="ts">
  import type { Question } from "$lib/events";

  let { id, questions, onSubmit }: {
    id: string;
    questions: Question[];
    onSubmit: (id: string, answers: string[][]) => void;
  } = $props();

  // answers[i] is the selection/text for question i.
  let answers = $state<string[][]>(questions.map(() => []));
  let text = $state<string[]>(questions.map(() => ""));

  function toggle(i: number, label: string, multi: boolean) {
    const cur = answers[i];
    if (multi) {
      answers[i] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    } else {
      answers[i] = [label];
    }
  }

  const ready = $derived(questions.every((q, i) =>
    q.kind === "text" ? (q.optional || text[i].trim().length > 0) : answers[i].length > 0));

  function send() {
    const payload = questions.map((q, i) => (q.kind === "text" ? [text[i]] : answers[i]));
    onSubmit(id, payload);
  }
</script>

<div class="k-ask">
  <div class="k-ask__banner">
    <span class="k-ask__banner-dot"></span>
    <span class="k-ask__banner-label">awaiting your input</span>
    <span class="k-ask__banner-tool">ask_user</span>
  </div>
  <div class="k-ask__body">
    {#each questions as q, i}
      <div class="k-ask__q">
        <div class="k-ask__q-head">
          <span class="k-ask__q-eyebrow">{q.header}</span>
          {#if q.kind === "select" && q.multi_select}<span class="k-ask__q-multi">choose any</span>{/if}
        </div>
        <div class="k-ask__q-text">{q.question}</div>

        {#if q.kind === "confirm"}
          <div class="k-ask__confirm">
            {#each (q.options ?? [{ label: "Yes" }, { label: "No" }]) as opt}
              <button type="button" class="k-ask__confirm-btn"
                class:k-ask__confirm-btn--selected={answers[i][0] === opt.label}
                onclick={() => (answers[i] = [opt.label])}>{opt.label}</button>
            {/each}
          </div>
        {:else if q.kind === "select"}
          <div class="k-ask__opts">
            {#each q.options ?? [] as opt}
              <button type="button" class="k-ask__opt"
                class:k-ask__opt--selected={answers[i].includes(opt.label)}
                onclick={() => toggle(i, opt.label, !!q.multi_select)}>
                <span class="k-ask__mark {q.multi_select ? 'k-ask__mark--check' : 'k-ask__mark--radio'}">
                  {#if answers[i].includes(opt.label)}{#if q.multi_select}✓{:else}<span class="k-ask__mark-dot"></span>{/if}{/if}
                </span>
                <span class="k-ask__opt-text">
                  <span class="k-ask__opt-label">{opt.label}</span>
                  {#if opt.description}<span class="k-ask__opt-desc">{opt.description}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
        {:else}
          <textarea class="k-textarea" rows="3" placeholder={q.placeholder ?? ""} bind:value={text[i]}></textarea>
        {/if}
      </div>
    {/each}
    <div class="k-ask__foot">
      <span class="k-ask__hint">the run is paused on the leash</span>
      <button class="k-btn k-btn--primary" disabled={!ready} onclick={send}>Send answer · resume</button>
    </div>
  </div>
</div>

<script lang="ts">
  import type { Question } from "$lib/events";

  let { id, questions, answers: answeredAnswers = null, onSubmit }: {
    id: string;
    questions: Question[];
    answers?: string[][] | null;
    onSubmit?: (id: string, answers: string[][]) => void;
  } = $props();

  // answers[i] is the selection/text for question i (interactive state only).
  let answers = $state<string[][]>(questions.map(() => []));
  let text = $state<string[]>(questions.map(() => ""));
  // Every select question carries a trailing "Other" row, as Claude Code's own
  // picker does: the operator is never boxed into the model's list. The typed
  // text travels as one more entry in that question's answer list.
  let otherOn = $state<boolean[]>(questions.map(() => false));
  let otherText = $state<string[]>(questions.map(() => ""));

  function toggle(i: number, label: string, multi: boolean) {
    const cur = answers[i];
    if (multi) {
      answers[i] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    } else {
      answers[i] = [label];
      otherOn[i] = false;
    }
  }

  function toggleOther(i: number, multi: boolean) {
    if (multi) {
      otherOn[i] = !otherOn[i];
    } else {
      answers[i] = [];
      otherOn[i] = true;
    }
  }

  function answerFor(q: Question, i: number): string[] {
    if (q.kind === "text") return [text[i]];
    const custom = q.kind === "select" && otherOn[i] ? otherText[i].trim() : "";
    return custom ? [...answers[i], custom] : answers[i];
  }

  // Picking Other commits to typing something: an empty Other never sends.
  const ready = $derived(questions.every((q, i) => {
    if (q.kind === "select" && otherOn[i] && !otherText[i].trim()) return false;
    if (q.optional) return true;
    return q.kind === "text" ? text[i].trim().length > 0 : answerFor(q, i).length > 0;
  }));

  function send() {
    onSubmit?.(id, questions.map(answerFor));
  }

  /** Answers to a select question that are not among its listed labels. */
  function customAnswers(q: Question, i: number): string[] {
    const labels = new Set((q.options ?? []).map((o) => o.label));
    return (answeredAnswers![i] ?? []).filter((a) => !labels.has(a));
  }

  const answered = $derived(answeredAnswers !== null);
</script>

<div class="k-ask" class:k-ask--answered={answered}>
  <div class="k-ask__banner">
    <span class="k-ask__banner-dot"></span>
    <span class="k-ask__banner-label">{answered ? "answered · run resumed" : "awaiting your input"}</span>
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

        {#if answered}
          <!-- Read-only answered state: show chosen selections or typed text -->
          {#if q.kind === "text"}
            {@const val = answeredAnswers![i]?.[0] ?? ""}
            <div class="k-ask__answer" class:k-ask__answer--empty={!val}>{val || "(no answer)"}</div>
          {:else}
            <!-- confirm / select: render options with chosen ones highlighted, disabled -->
            {#if q.kind === "confirm"}
              <div class="k-ask__confirm">
                {#each (q.options ?? [{ label: "Yes" }, { label: "No" }]) as opt}
                  <button type="button" class="k-ask__confirm-btn" disabled
                    class:k-ask__confirm-btn--selected={answeredAnswers![i]?.[0] === opt.label}>{opt.label}</button>
                {/each}
              </div>
            {:else}
              <div class="k-ask__opts">
                {#each q.options ?? [] as opt}
                  <button type="button" class="k-ask__opt" disabled
                    class:k-ask__opt--selected={answeredAnswers![i]?.includes(opt.label)}>
                    <span class="k-ask__mark {q.multi_select ? 'k-ask__mark--check' : 'k-ask__mark--radio'}">
                      {#if answeredAnswers![i]?.includes(opt.label)}{#if q.multi_select}✓{:else}<span class="k-ask__mark-dot"></span>{/if}{/if}
                    </span>
                    <span class="k-ask__opt-text">
                      <span class="k-ask__opt-label">{opt.label}</span>
                      {#if opt.description}<span class="k-ask__opt-desc">{opt.description}</span>{/if}
                    </span>
                  </button>
                {/each}
                {#if customAnswers(q, i).length > 0}
                  <button type="button" class="k-ask__opt k-ask__opt--selected" disabled>
                    <span class="k-ask__mark {q.multi_select ? 'k-ask__mark--check' : 'k-ask__mark--radio'}">
                      {#if q.multi_select}✓{:else}<span class="k-ask__mark-dot"></span>{/if}
                    </span>
                    <span class="k-ask__opt-text">
                      <span class="k-ask__opt-label">Other</span>
                      {#each customAnswers(q, i) as c}<span class="k-ask__opt-desc k-ask__other-answer">{c}</span>{/each}
                    </span>
                  </button>
                {/if}
              </div>
            {/if}
          {/if}
        {:else}
          <!-- Interactive state -->
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
              <button type="button" class="k-ask__opt"
                class:k-ask__opt--selected={otherOn[i]}
                onclick={() => toggleOther(i, !!q.multi_select)}>
                <span class="k-ask__mark {q.multi_select ? 'k-ask__mark--check' : 'k-ask__mark--radio'}">
                  {#if otherOn[i]}{#if q.multi_select}✓{:else}<span class="k-ask__mark-dot"></span>{/if}{/if}
                </span>
                <span class="k-ask__opt-text">
                  <span class="k-ask__opt-label">Other</span>
                  <span class="k-ask__opt-desc">type your own answer</span>
                </span>
              </button>
              {#if otherOn[i]}
                <!-- svelte-ignore a11y_autofocus -->
                <textarea class="k-textarea" rows="2" placeholder="Your answer" autofocus
                  aria-label="Other answer" bind:value={otherText[i]}></textarea>
              {/if}
            </div>
          {:else}
            <textarea class="k-textarea" rows="3" placeholder={q.placeholder ?? ""} bind:value={text[i]}></textarea>
          {/if}
        {/if}
      </div>
    {/each}
    {#if !answered}
      <div class="k-ask__foot">
        <span class="k-ask__hint">the run is paused on the leash</span>
        <button class="k-btn k-btn--primary" disabled={!ready} onclick={send}>Send answer · resume</button>
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { CatalogEntry } from "../../bindings/CatalogEntry";
  import KitChecklist from "./KitChecklist.svelte";
  import Field from "./Field.svelte";
  import Segmented from "./Segmented.svelte";
  import Folder from "@lucide/svelte/icons/folder";

  let {
    spec,
    entries,
    onPickWorkdir,
  }: { spec: RunSpec; entries: CatalogEntry[]; onPickWorkdir: () => void } = $props();

  let kitCount = $derived(spec.skills.length + Object.keys(spec.plugins).length);

  // Integer-coerce the leash inputs (mirrors kata-core's expectations).
  function onMaxTurns(e: Event) {
    const n = Math.trunc(Number((e.currentTarget as HTMLInputElement).value));
    spec.leash.max_turns = Number.isFinite(n) && n >= 1 ? n : 1;
  }
  function onTimeout(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    if (v === "") {
      spec.leash.timeout_secs = null;
      return;
    }
    const n = Math.trunc(Number(v));
    spec.leash.timeout_secs = Number.isFinite(n) && n >= 0 ? n : null;
  }
</script>

<div class="wb-compose">
  <Field label="Description" key="description">
    <input class="k-input" placeholder="One line — what this form is for" bind:value={spec.description} />
  </Field>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__title">Task</span>
      <span class="wb-section__sub">the job, verbatim</span>
    </div>
    <Field label="Task" key="task">
      <textarea class="k-textarea" rows="3" bind:value={spec.task}></textarea>
    </Field>
    <Field label="Context" key="context" hint="Appended after the task.">
      <textarea class="k-textarea" rows="2" bind:value={spec.context}></textarea>
    </Field>
    <Field label="Workdir" key="workdir" hint="cwd for claude -p; the agent's file tools resolve here.">
      <div class="wb-picker">
        <input class="k-input k-input--mono" bind:value={spec.workdir} />
        <button type="button" class="k-btn k-btn--secondary" onclick={onPickWorkdir}>
          <Folder size={16} />Browse…
        </button>
      </div>
    </Field>
  </section>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__num">02 · TELL IT WHAT IT IS</span>
      <span class="wb-section__title">Identity</span>
    </div>
    <Field label="System prompt" key="identity.system_prompt" hint="Empty = stay the default coding assistant.">
      <textarea class="k-textarea" rows="2" bind:value={spec.identity.system_prompt}></textarea>
    </Field>
    <Field label="Mode" key="identity.mode">
      <Segmented options={["append", "replace"] as const} bind:value={spec.identity.mode} ariaLabel="Identity mode" />
    </Field>
  </section>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__num">03 · THE CURATED KIT</span>
      <span class="wb-section__title">Kit</span>
      <span class="wb-section__sub">{kitCount} selected</span>
    </div>
    <KitChecklist {spec} {entries} />
  </section>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__title">Model</span>
    </div>
    <Field label="Model id" key="model.id" hint="Omit to use Claude's default.">
      <select class="k-select" bind:value={spec.model.id}>
        <option value="">(default)</option>
        <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
        <option value="claude-opus-4-1">claude-opus-4-1</option>
        <option value="claude-haiku-4-5">claude-haiku-4-5</option>
      </select>
    </Field>
  </section>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__title">Environment</span>
      <span class="wb-section__sub">the room claude runs in</span>
    </div>
    <Field label="Room" key="auth.bare" hint="bare = the empty room (curated kit only). full = your real claude config, plugins, and login.">
      <Segmented
        options={["bare", "full"] as const}
        value={spec.auth.bare ? "bare" : "full"}
        onChange={(v) => (spec.auth.bare = v === "bare")}
        ariaLabel="Environment"
      />
    </Field>
    {#if spec.auth.bare}
      <Field label="Token env var" key="auth.token_env" hint="Name of an env var holding your API key — not the key itself.">
        <input class="k-input k-input--mono" placeholder="ANTHROPIC_API_KEY" bind:value={spec.auth.token_env} />
      </Field>
    {/if}
  </section>

  <section class="wb-section">
    <div class="wb-section__head">
      <span class="wb-section__num">04 · THE LEASH</span>
      <span class="wb-section__title">Leash</span>
      <span class="wb-section__sub">cap · contain · observe</span>
    </div>
    <div class="wb-grid-2">
      <Field label="Max turns" key="max_turns" hint="Engine cap → exit 125.">
        <input class="k-input" type="number" min="1" step="1" value={spec.leash.max_turns} oninput={onMaxTurns} />
      </Field>
      <Field label="Timeout (secs)" key="timeout_secs" hint="Wall-clock kill → exit 124.">
        <input class="k-input" type="number" min="0" step="1" placeholder="(none)" value={spec.leash.timeout_secs ?? ""} oninput={onTimeout} />
      </Field>
    </div>
    <Field label="Isolation" key="leash.isolation" hint="worktree contains writes in an ephemeral git worktree (reviewable as a diff).">
      <Segmented options={["none", "worktree"] as const} bind:value={spec.leash.isolation} ariaLabel="Isolation" />
    </Field>
  </section>
</div>

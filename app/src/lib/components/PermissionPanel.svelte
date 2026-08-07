<script lang="ts">
  /* Approval card for a paused permission check. Same anatomy as AskPanel —
   * the run is stopped on the leash either way — but the body is one tool call
   * and the choice is binary, so it reuses the .k-ask__confirm treatment rather
   * than inventing a second visual language for "the run needs you". */
  import type { PermissionRecord } from "$lib/events";

  let { id, tool, input_summary, decided = null, onDecide }: {
    id: string;
    tool: string;
    input_summary: string;
    decided?: PermissionRecord["decided"];
    onDecide?: (id: string, allow: boolean, message: string | null) => void;
  } = $props();

  let reason = $state("");

  const settled = $derived(decided !== null);
  const label = $derived(
    !decided ? "awaiting your decision" : decided.allow ? "allowed · run resumed" : "denied · run resumed",
  );
</script>

<div class="k-ask" class:k-ask--answered={settled}>
  <div class="k-ask__banner">
    <span class="k-ask__banner-dot"></span>
    <span class="k-ask__banner-label">{label}</span>
    <span class="k-ask__banner-tool">permission</span>
  </div>
  <div class="k-ask__body">
    <div class="k-ask__q">
      <div class="k-ask__q-head">
        <span class="k-ask__q-eyebrow">{tool}</span>
      </div>
      <div class="k-ask__q-text">Allow this tool call?</div>
      <div class="k-ask__answer" class:k-ask__answer--empty={!input_summary}>
        {input_summary || "(no input)"}
      </div>

      {#if settled}
        <div class="k-ask__confirm">
          <button type="button" class="k-ask__confirm-btn" disabled
            class:k-ask__confirm-btn--selected={decided!.allow}>Allow</button>
          <button type="button" class="k-ask__confirm-btn" disabled
            class:k-ask__confirm-btn--selected={!decided!.allow}>Deny</button>
        </div>
        {#if decided!.message}
          <div class="k-ask__answer">{decided!.message}</div>
        {/if}
      {:else}
        <textarea
          class="k-textarea"
          rows="2"
          placeholder="reason (optional — claude sees this on a denial)"
          bind:value={reason}
        ></textarea>
      {/if}
    </div>

    {#if !settled}
      <div class="k-ask__foot">
        <span class="k-ask__hint">the run is paused on the leash</span>
        <button class="k-btn" onclick={() => onDecide?.(id, false, reason.trim() || null)}>Deny</button>
        <button class="k-btn k-btn--primary" onclick={() => onDecide?.(id, true, null)}>Allow · resume</button>
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import type { Todo } from "$lib/toolcards";
  import Check from "@lucide/svelte/icons/check";
  import CircleDot from "@lucide/svelte/icons/circle-dot";
  import Circle from "@lucide/svelte/icons/circle";

  let { todos }: { todos: Todo[] } = $props();
</script>

<ul class="k-toolcard__todo">
  {#each todos as t, i (i)}
    <li class="k-toolcard__todo-item k-toolcard__todo-item--{t.status}">
      {#if t.status === "completed"}<Check size={12} />{:else if t.status === "in_progress"}<CircleDot size={12} />{:else}<Circle size={12} />{/if}
      <span>{t.content}</span>
    </li>
  {/each}
</ul>

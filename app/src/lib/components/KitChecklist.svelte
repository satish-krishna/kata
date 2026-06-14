<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { CatalogEntry } from "../../bindings/CatalogEntry";
  import { groupCatalog, isSkillSelected, toggleSkill, isPluginSelected, togglePlugin, setPluginMcp, setPluginEnv } from "../kit";

  let { spec, entries }: { spec: RunSpec; entries: CatalogEntry[] } = $props();

  let query = $state("");
  let grouped = $derived(groupCatalog(entries));
  let filtered = $derived({
    skills: grouped.skills.filter((e) => e.name.includes(query) || e.description.includes(query)),
    plugins: grouped.plugins.filter((e) => e.name.includes(query) || e.description.includes(query)),
  });

  const envText = (name: string) => (spec.plugins[name]?.env ?? []).join(", ");
  const onEnvInput = (name: string, value: string) =>
    setPluginEnv(spec, name, value.split(",").map((s) => s.trim()).filter(Boolean));
</script>

<div class="kit">
  <input placeholder="search kit…" bind:value={query} />

  <h4>Skills</h4>
  {#each filtered.skills as e (e.name)}
    <label class="row">
      <input type="checkbox" checked={isSkillSelected(spec, e.name)} onchange={() => toggleSkill(spec, e.name)} />
      <span class="tag">skill</span>
      <span class="name">{e.name}</span>
      <span class="desc">{e.description}</span>
    </label>
  {/each}

  <h4>Plugins</h4>
  {#each filtered.plugins as e (e.name)}
    <label class="row">
      <input type="checkbox" checked={isPluginSelected(spec, e.name)} onchange={() => togglePlugin(spec, e.name)} />
      <span class="tag plugin">plugin</span>
      <span class="name">{e.name}</span>
      <span class="desc">{e.description}</span>
    </label>
    {#if isPluginSelected(spec, e.name)}
      <div class="plugin-detail">
        {#if e.provides.length}<div class="provides">provides: {e.provides.join(", ")}</div>{/if}
        {#if e.mcp_servers.length}
          <label class="mcp">
            <input type="checkbox" checked={spec.plugins[e.name]?.mcp ?? true} onchange={(ev) => setPluginMcp(spec, e.name, ev.currentTarget.checked)} />
            start MCP servers ({e.mcp_servers.join(", ")})
          </label>
          <label class="env">
            env passthrough (names, comma-separated):
            <input value={envText(e.name)} onchange={(ev) => onEnvInput(e.name, ev.currentTarget.value)} />
          </label>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .kit { display: flex; flex-direction: column; gap: 0.25rem; }
  .row { display: flex; gap: 0.5rem; align-items: baseline; }
  .tag { font-size: 0.7rem; background: #e3effd; color: #1c5fb0; padding: 0 0.3rem; border-radius: 3px; }
  .tag.plugin { background: #ece3fd; color: #5b1cb0; }
  .name { font-weight: 600; }
  .desc { color: #777; font-size: 0.8rem; }
  .plugin-detail { margin: 0 0 0.5rem 1.8rem; font-size: 0.8rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .provides { color: #777; }
</style>

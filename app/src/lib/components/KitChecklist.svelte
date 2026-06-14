<script lang="ts">
  import type { RunSpec } from "../../bindings/RunSpec";
  import type { CatalogEntry } from "../../bindings/CatalogEntry";
  import { groupCatalog, isSkillSelected, toggleSkill, isPluginSelected, togglePlugin, setPluginMcp, setPluginEnv } from "../kit";
  import Field from "./Field.svelte";
  import Search from "@lucide/svelte/icons/search";
  import Check from "@lucide/svelte/icons/check";

  let { spec, entries }: { spec: RunSpec; entries: CatalogEntry[] } = $props();

  let query = $state("");
  let grouped = $derived(groupCatalog(entries));
  const match = (e: CatalogEntry, q: string) => {
    const s = q.toLowerCase();
    return e.name.toLowerCase().includes(s) || e.description.toLowerCase().includes(s);
  };
  let filtered = $derived({
    skills: grouped.skills.filter((e) => match(e, query)),
    plugins: grouped.plugins.filter((e) => match(e, query)),
  });

  const envText = (name: string) => (spec.plugins[name]?.env ?? []).join(", ");
  const onEnvInput = (name: string, value: string) =>
    setPluginEnv(spec, name, value.split(",").map((s) => s.trim()).filter(Boolean));
</script>

<div class="wb-kit">
  <div class="wb-kit__search">
    <Search />
    <input class="k-input" placeholder="search kit…" bind:value={query} aria-label="Search kit" />
  </div>

  <div>
    <div class="wb-kit__group">Skills</div>
    {#each filtered.skills as e (e.name)}
      <div class="k-kit" class:k-kit--selected={isSkillSelected(spec, e.name)}>
        <label class="k-kit__main">
          <span class="k-kit__check k-check">
            <input type="checkbox" checked={isSkillSelected(spec, e.name)} onchange={() => toggleSkill(spec, e.name)} />
            <span class="k-check__box"><Check size={11} /></span>
          </span>
          <span class="k-tag k-tag--skill">skill</span>
          <span class="k-kit__name">{e.name}</span>
          <span class="k-kit__desc">{e.description}</span>
        </label>
      </div>
    {/each}
  </div>

  <div>
    <div class="wb-kit__group">Plugins</div>
    {#each filtered.plugins as e (e.name)}
      {@const selected = isPluginSelected(spec, e.name)}
      <div class="k-kit" class:k-kit--selected={selected}>
        <label class="k-kit__main">
          <span class="k-kit__check k-check">
            <input type="checkbox" checked={selected} onchange={() => togglePlugin(spec, e.name)} />
            <span class="k-check__box"><Check size={11} /></span>
          </span>
          <span class="k-tag k-tag--plugin">plugin</span>
          <span class="k-kit__name">{e.name}</span>
          <span class="k-kit__desc">{e.description}</span>
        </label>
        {#if selected}
          <div class="k-kit__detail">
            {#if e.provides.length}
              <div class="k-kit__provides"><b>provides:</b> {e.provides.join(", ")}</div>
            {/if}
            {#if e.mcp_servers.length}
              <label class="k-check">
                <input type="checkbox" checked={spec.plugins[e.name]?.mcp ?? true} onchange={(ev) => setPluginMcp(spec, e.name, ev.currentTarget.checked)} />
                <span class="k-check__box"><Check size={11} /></span>
                start MCP servers ({e.mcp_servers.join(", ")})
              </label>
              <Field label="env passthrough" key="env" hint="Names only — never values. Forwarded from the runtime env.">
                <input class="k-input k-input--mono" value={envText(e.name)} onchange={(ev) => onEnvInput(e.name, ev.currentTarget.value)} placeholder="GITHUB_TOKEN, GH_HOST" />
              </Field>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

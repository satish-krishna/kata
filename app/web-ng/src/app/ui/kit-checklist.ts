import { Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch } from '@ng-icons/lucide';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { RunSpec } from '@bindings/RunSpec';
import {
  groupCatalog,
  isPluginSelected,
  isSkillSelected,
  setPluginEnv,
  setPluginMcp,
  togglePlugin,
  toggleSkill,
} from '../lib/kit';
import { Field } from './field';

const match = (e: CatalogEntry, q: string): boolean => {
  const s = q.toLowerCase();
  return e.name.toLowerCase().includes(s) || e.description.toLowerCase().includes(s);
};

@Component({
  selector: 'app-kit-checklist',
  imports: [NgIcon, HlmInput, HlmLabel, HlmCheckbox, Field],
  providers: [provideIcons({ lucideSearch })],
  template: `
    <div class="wb-kit">
      <div class="wb-kit__search">
        <ng-icon name="lucideSearch" />
        <input hlmInput placeholder="search kit…" aria-label="Search kit" [value]="query()" (input)="onQuery($event)" />
      </div>

      <div>
        <div class="wb-kit__group">Skills</div>
        @for (e of filtered().skills; track e.name) {
          <div class="k-kit" [class.k-kit--selected]="skillOn(e.name)">
            <label hlmLabel class="k-kit__main">
              <hlm-checkbox class="k-kit__check" [checked]="skillOn(e.name)" (checkedChange)="toggleSkillNamed(e.name)" />
              <span class="k-tag k-tag--skill">skill</span>
              <span class="k-kit__name">{{ e.name }}</span>
              <span class="k-kit__desc">{{ e.description }}</span>
            </label>
          </div>
        }
      </div>

      <div>
        <div class="wb-kit__group">Plugins</div>
        @for (e of filtered().plugins; track e.name) {
          <div class="k-kit" [class.k-kit--selected]="pluginOn(e.name)">
            <label hlmLabel class="k-kit__main">
              <hlm-checkbox class="k-kit__check" [checked]="pluginOn(e.name)" (checkedChange)="togglePluginNamed(e.name)" />
              <span class="k-tag k-tag--plugin">plugin</span>
              <span class="k-kit__name">{{ e.name }}</span>
              <span class="k-kit__desc">{{ e.description }}</span>
            </label>
            @if (pluginOn(e.name)) {
              <div class="k-kit__detail">
                @if (e.provides.length) {
                  <div class="k-kit__provides"><b>provides:</b> {{ e.provides.join(', ') }}</div>
                }
                @if (e.mcp_servers.length) {
                  <label hlmLabel class="k-kit__mcp">
                    <hlm-checkbox [checked]="spec().plugins[e.name]?.mcp ?? true" (checkedChange)="setMcp(e.name, $event)" />
                    start MCP servers ({{ e.mcp_servers.join(', ') }})
                  </label>
                  <app-field label="env passthrough" key="env" hint="Names only — never values. Forwarded from the runtime env.">
                    <input
                      hlmInput
                      variant="mono"
                      placeholder="GITHUB_TOKEN, GH_HOST"
                      [value]="envText(e.name)"
                      (change)="onEnvInput(e.name, $event)"
                    />
                  </app-field>
                }
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class KitChecklist {
  readonly spec = input.required<RunSpec>();
  readonly entries = input.required<CatalogEntry[]>();
  /** The next spec after a toggle. Always a fresh copy; the input spec is never touched. */
  readonly specChange = output<RunSpec>();

  protected readonly query = signal('');
  private readonly grouped = computed(() => groupCatalog(this.entries()));
  protected readonly filtered = computed(() => {
    const q = this.query();
    const g = this.grouped();
    return { skills: g.skills.filter((e) => match(e, q)), plugins: g.plugins.filter((e) => match(e, q)) };
  });

  protected skillOn(name: string): boolean {
    return isSkillSelected(this.spec(), name);
  }
  protected pluginOn(name: string): boolean {
    return isPluginSelected(this.spec(), name);
  }
  protected envText(name: string): string {
    return (this.spec().plugins[name]?.env ?? []).join(', ');
  }

  protected onQuery(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
  }

  protected toggleSkillNamed(name: string): void {
    this.apply((s) => toggleSkill(s, name));
  }
  protected togglePluginNamed(name: string): void {
    this.apply((s) => togglePlugin(s, name));
  }
  protected setMcp(name: string, on: boolean): void {
    this.apply((s) => setPluginMcp(s, name, on));
  }
  protected onEnvInput(name: string, e: Event): void {
    const names = (e.target as HTMLInputElement).value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.apply((s) => setPluginEnv(s, name, names));
  }

  /** Every lib/kit.ts helper mutates its argument, so run it on a clone and emit the result. */
  private apply(mutate: (s: RunSpec) => void): void {
    const next = structuredClone(this.spec());
    mutate(next);
    this.specChange.emit(next);
  }
}

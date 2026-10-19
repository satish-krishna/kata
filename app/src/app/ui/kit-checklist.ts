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
  templateUrl: './kit-checklist.html',
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

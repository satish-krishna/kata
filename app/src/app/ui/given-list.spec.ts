import { TestBed } from '@angular/core/testing';
import type { Resolved } from '@bindings/Resolved';
import type { ResolvedItem } from '@bindings/ResolvedItem';
import type { ItemKind } from '@bindings/ItemKind';
import type { Source } from '@bindings/Source';
import { groupRows, presetRows, type PresetFrom, type PresetRow } from '../lib/given';
import { previewFixture, seedSpec } from '../lib/mock';
import { render } from '../../testing/render';
import { GivenList } from './given-list';

const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
const FROM: PresetFrom = { workdir: seedSpec().workdir, session: new Set(), job: null, build: null };
const fixtureRows = () => presetRows(previewFixture(seedSpec(), []), FROM).rows;

const SOURCE_TEXT: Record<string, string> = {
  personal: 'personal setup',
  project: 'project',
  plugin: 'plugin',
  organization: 'organization',
  kata: 'Kata itself',
  'run-spec': 'run-spec',
};
const KIND_TEXT: Record<string, string> = { hook: 'hook', skill: 'skill', plugin: 'plugin', instruction: 'standing instruction', 'tool-server': 'tool server' };

describe('GivenList', () => {
  const pairs: [ItemKind, Source][] = [
    ['hook', 'personal'], ['hook', 'project'], ['hook', 'plugin'], ['hook', 'organization'],
    ['skill', 'personal'], ['skill', 'project'], ['skill', 'plugin'], ['skill', 'run-spec'],
    ['plugin', 'personal'], ['plugin', 'project'], ['plugin', 'run-spec'],
    ['instruction', 'personal'], ['instruction', 'project'], ['instruction', 'kata'], ['instruction', 'run-spec'],
    ['tool-server', 'personal'], ['tool-server', 'project'], ['tool-server', 'plugin'], ['tool-server', 'kata'],
  ];

  it.each(pairs)('each item is listed under its kind and labeled with its source: %s from %s', async (kind, source) => {
    const rows = fixtureRows();
    const row = rows.find((r) => r.item.kind === kind && r.item.source === source)!;
    expect(row).toBeDefined();
    const { container } = await render(GivenList, { groups: groupRows(rows), readonly: false });
    const el = container.querySelector(`[data-row="${row.key}"]`)!;
    expect(el).not.toBeNull();
    expect(el.querySelector('[data-source-tag]')!.textContent!.trim()).toBe(SOURCE_TEXT[source]);
    if (row.item.brought_by === null) {
      // A top-level item sits under its kind, then its source.
      const group = el.closest('[data-source]')!;
      expect(group.getAttribute('data-source')).toBe(source);
      expect(group.closest('[data-kind]')!.getAttribute('data-kind')).toBe(kind);
    } else {
      // A plugin's own hook, skill or tool server is listed under the plugin that brings it, and says what kind it is.
      expect(el.closest('[data-kind]')!.getAttribute('data-kind')).toBe('plugin');
      expect(text(el.querySelector('[data-kind-tag]')!)).toBe(KIND_TEXT[kind]);
    }
  });

  it('forty items from four sources are grouped by kind then source with counts', async () => {
    const kinds: ItemKind[] = ['hook', 'skill', 'tool-server'];
    const sources: Source[] = ['personal', 'project', 'organization', 'kata'];
    const items: ResolvedItem[] = [];
    for (const kind of kinds)
      for (const source of sources)
        for (let i = 0; i < (kind === 'hook' ? 4 : 3); i++)
          items.push({ id: `${source}:${kind}:n${i}`, kind, source, name: `${kind}-${source}-${i}`, detail: 'd', path: null, brought_by: null, lock: null, off: false });
    expect(items).toHaveLength(40);
    const resolved: Resolved = { items, settings: previewFixture(seedSpec(), []).settings, env: [], missing: [], problems: [] };
    const off = new Set(['personal:hook:n0', 'personal:hook:n1']);
    const rows = presetRows(resolved, { ...FROM, session: off }).rows;
    const { container } = await render(GivenList, { groups: groupRows(rows), readonly: false });
    expect(container.querySelectorAll('[data-row]')).toHaveLength(40);
    const kindSections = Array.from(container.querySelectorAll('[data-kind]'));
    expect(kindSections.map((k) => k.getAttribute('data-kind'))).toEqual(['hook', 'skill', 'tool-server']);
    expect(text(kindSections[0].querySelector('[data-kind-header]')!)).toContain('Hooks');
    expect(text(kindSections[0].querySelector('[data-kind-header]')!)).toContain('16 · 2 off');
    const hookGroups = Array.from(kindSections[0].querySelectorAll('[data-source]'));
    expect(hookGroups.map((g) => g.getAttribute('data-source'))).toEqual(['personal', 'project', 'organization', 'kata']);
    expect(text(hookGroups[0].querySelector('[data-source-header]')!)).toContain('personal setup');
    expect(text(hookGroups[0].querySelector('[data-source-header]')!)).toContain('4 · 2 off');
    expect(text(hookGroups[1].querySelector('[data-source-header]')!)).toContain('4 · 0 off');
    expect(text(kindSections[1].querySelector('[data-kind-header]')!)).toContain('12 · 0 off');
  });

  it('a readonly list has no switches', async () => {
    const groups = groupRows(fixtureRows());
    const live = await render(GivenList, { groups, readonly: false });
    expect(live.container.querySelectorAll('hlm-switch').length).toBeGreaterThan(0);
    TestBed.resetTestingModule();
    const { container } = await render(GivenList, { groups, readonly: true });
    expect(container.querySelectorAll('hlm-switch')).toHaveLength(0);
  });

  it('a locked row and a follower have no switch, and a locked row says why', async () => {
    const rows = fixtureRows();
    const { container } = await render(GivenList, { groups: groupRows(rows), readonly: false });
    const locked = rows.find((r) => r.locked?.kind === 'kata')!;
    const lockedEl = container.querySelector(`[data-row="${locked.key}"]`)!;
    expect(lockedEl.querySelector('hlm-switch')).toBeNull();
    expect(text(lockedEl)).toContain('the run needs it to ask you questions');
    const follower = rows.find((r) => r.locked?.kind === 'follows-plugin')!;
    expect(container.querySelector(`[data-row="${follower.key}"] hlm-switch`)).toBeNull();
  });

  it('a switch emits the key and the new state, and the mark and status label show', async () => {
    const rows = presetRows(previewFixture(seedSpec(), []), { ...FROM, session: new Set(['personal:tool-server:github']) }).rows;
    const status = (r: PresetRow) => (r.item.name === 'github' ? 'seen' : null);
    const { fixture, container } = await render(GivenList, { groups: groupRows(rows), readonly: false, statusLabel: status });
    const got: unknown[] = [];
    fixture.componentInstance.toggle.subscribe((v) => got.push(v));
    const el = container.querySelector('[data-row="personal:tool-server:github"]')!;
    expect(text(el)).toContain('kept from an earlier run');
    expect(text(el)).toContain('seen');
    el.querySelector<HTMLElement>('[role="switch"]')!.click();
    expect(got).toEqual([{ key: 'personal:tool-server:github', off: false }]);
  });
});

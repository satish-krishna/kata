import { TestBed } from '@angular/core/testing';
import type { Resolved } from '@bindings/Resolved';
import type { ResolvedItem } from '@bindings/ResolvedItem';
import { givenKey, presetRows, toggle, type PresetRow } from '../../lib/given';
import { GivenStore } from './given.store';

const WS_A = 'D:\ws\a';
const WS_B = 'D:\ws\b';

const item = (id: string, extra: Partial<ResolvedItem> = {}): ResolvedItem => {
  const [source, kind, ...name] = id.split(':');
  return { id, kind: kind as ResolvedItem['kind'], source: source as ResolvedItem['source'], name: name.join(':'), detail: '', path: null, brought_by: null, lock: null, off: false, goes_off_with: [], ...extra } as ResolvedItem;
};
const resolved = (items: ResolvedItem[]): Resolved => ({ items, settings: {} as Resolved['settings'], env: [], missing: [], problems: [], empty_room: false });
const rowsOf = (items: ResolvedItem[], workdir: string, session: ReadonlySet<string> = new Set()): PresetRow[] =>
  presetRows(resolved(items), { workdir, session, job: null, build: null }).rows;

const dbA = item('project:tool-server:db');
const github = item('personal:tool-server:github');
const kataAsk = item('kata:tool-server:kata-ask', { lock: { kind: 'kata', text: 'the run needs it' } });
const store = (): GivenStore => TestBed.runInInjectionContext(() => new GivenStore());

describe('GivenStore', () => {
  it('a new store remembers nothing', () => {
    const s = store();
    expect(s.session().size).toBe(0);
    const rows = rowsOf([github, dbA, kataAsk], WS_A, s.session());
    expect(rows.every((r) => !r.off)).toBe(true);
  });

  it('a choice for an item a preview does not list is kept', () => {
    const s = store();
    const a = toggle(rowsOf([dbA, github], WS_A), givenKey(dbA.id, WS_A), true);
    s.remember(a, WS_A);
    expect(s.session().has(givenKey(dbA.id, WS_A))).toBe(true);

    s.remember(rowsOf([github], WS_B, s.session()), WS_B);
    expect(s.session().has(givenKey(dbA.id, WS_A))).toBe(true);

    const later = rowsOf([dbA, github], WS_A, s.session());
    expect(later.find((r) => r.item.id === dbA.id)).toMatchObject({ off: true, mark: 'kept' });
  });

  it('build choices are gone with a new store', () => {
    const s = store();
    s.setBuild('build:claims/fnol', { off: new Set([givenKey(github.id, WS_A)]) });
    expect(s.build('build:claims/fnol')?.off.has(givenKey(github.id, WS_A))).toBe(true);
    expect(store().build('build:claims/fnol')).toBeNull();
  });

  it('locked rows are never remembered', () => {
    const s = store();
    const locked: PresetRow = { item: kataAsk, key: kataAsk.id, off: true, locked: kataAsk.lock, mark: null };
    const follower: PresetRow = { item: item('plugin:skill:p:s', { brought_by: 'personal:plugin:p', lock: { kind: 'follows-plugin', plugin: 'personal:plugin:p' } }), key: 'plugin:skill:p:s', off: true, locked: { kind: 'follows-plugin', plugin: 'personal:plugin:p' }, mark: null };
    s.remember([locked, follower], WS_A);
    expect(s.session().size).toBe(0);
  });

  it('switching back on forgets the key', () => {
    const s = store();
    const key = givenKey(github.id, WS_A);
    s.remember(toggle(rowsOf([github], WS_A), key, true), WS_A);
    expect(s.session().has(key)).toBe(true);
    s.remember(rowsOf([github], WS_A), WS_A);
    expect(s.session().has(key)).toBe(false);
  });

  it('session() cannot be changed through a later remember of a held snapshot', () => {
    const s = store();
    const before = s.session();
    s.remember(toggle(rowsOf([github], WS_A), givenKey(github.id, WS_A), true), WS_A);
    expect(before.size).toBe(0);
  });
});

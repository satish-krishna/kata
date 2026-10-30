import type { Given } from '@bindings/Given';
import type { ItemKind } from '@bindings/ItemKind';
import type { LockReason } from '@bindings/LockReason';
import type { Resolved } from '@bindings/Resolved';
import type { ResolvedItem } from '@bindings/ResolvedItem';
import type { Source } from '@bindings/Source';
import { runGivenFixture } from './library';
import { groupRows, givenKey, presetRows, modeOf, settingSourceLabel, toGiven, toggle, type PresetFrom, type PresetRow } from './given';

const WORKDIR = 'D:\\ws\\commerce\\';
const KATA_LOCK: LockReason = { kind: 'kata', text: 'the run needs it to ask you questions' };

const item = (kind: ItemKind, source: Source, key: string, extra: Partial<ResolvedItem> = {}): ResolvedItem => ({
  id: `${source}:${kind}:${key}`, kind, source, name: key.split('@')[0], detail: '', path: null, brought_by: null, lock: null, off: false, goes_off_with: [], ...extra,
});
const resolved = (items: ResolvedItem[], missing: string[] = []): Resolved => ({
  items, settings: {} as Resolved['settings'], env: [], missing, problems: [], empty_room: false,
});
const noGiven: Given = { hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [] };
const from = (over: Partial<PresetFrom> = {}): PresetFrom => ({ workdir: WORKDIR, session: new Set(), job: null, build: null, ...over });
const byId = (rows: PresetRow[], id: string): PresetRow => rows.find((r) => r.item.id === id)!;

const github = item('tool-server', 'personal', 'github');
const dbServer = item('tool-server', 'project', 'commerce-db');
const kataAsk = item('tool-server', 'kata', 'kata-ask', { name: 'kata-ask', lock: KATA_LOCK });

describe('givenKey', () => {
  it('givenKey qualifies project items only', () => {
    expect(givenKey('project:hook:a:b', 'D:\\ws\\Commerce\\')).toBe('d:/ws/Commerce|project:hook:a:b');
    expect(givenKey('project-local:instruction:CLAUDE.local.md', 'D:/ws/commerce')).toBe('d:/ws/commerce|project-local:instruction:CLAUDE.local.md');
    expect(givenKey('personal:tool-server:github', 'D:\\ws\\commerce')).toBe('personal:tool-server:github');
    expect(givenKey('plugin:skill:x:y', 'D:\\ws\\commerce')).toBe('plugin:skill:x:y');
  });
});

describe('presetRows', () => {
  it('presetRows decides every row of the pre-set table', () => {
    const r = resolved([github, dbServer, kataAsk]);
    const dbKey = givenKey(dbServer.id, WORKDIR);
    const ghKey = givenKey(github.id, WORKDIR);

    // 1: locked, listed off in the job -> on, locked, no mark, warning
    const one = presetRows(r, from({ job: { ...noGiven, tool_servers: [kataAsk.id] } }));
    expect(byId(one.rows, kataAsk.id)).toMatchObject({ off: false, mark: null, locked: KATA_LOCK });
    expect(one.warnings).toEqual(['The job switches off `kata-ask`; its choice was ignored: the run needs it to ask you questions']);
    // 1 (build): locked, listed in the build keys -> same
    const oneBuild = presetRows(r, from({ build: new Set([kataAsk.id]) }));
    expect(byId(oneBuild.rows, kataAsk.id)).toMatchObject({ off: false, mark: null });
    expect(oneBuild.warnings).toHaveLength(1);

    // 2: locked, not listed -> on, locked, no warning
    const two = presetRows(r, from({ job: noGiven }));
    expect(byId(two.rows, kataAsk.id)).toMatchObject({ off: false, mark: null, locked: KATA_LOCK });
    expect(two.warnings).toEqual([]);

    // 3: unlocked, build choices, listed in build -> off, mark build
    const three = presetRows(r, from({ build: new Set([ghKey]), session: new Set([dbKey]) }));
    expect(byId(three.rows, github.id)).toMatchObject({ off: true, mark: 'build', key: ghKey });
    // 4: unlocked, build choices, not listed -> on (the session is ignored)
    expect(byId(three.rows, dbServer.id)).toMatchObject({ off: false, mark: null });
    expect(three.warnings).toEqual([]);

    // 5: unlocked, job section, listed in job -> off, mark job (a project item is listed by plain id)
    const five = presetRows(r, from({ job: { ...noGiven, tool_servers: [dbServer.id] } }));
    expect(byId(five.rows, dbServer.id)).toMatchObject({ off: true, mark: 'job' });
    // 6: unlocked, job section, not listed -> on (the session is ignored)
    const six = presetRows(r, from({ job: { ...noGiven, tool_servers: [dbServer.id] }, session: new Set([ghKey]) }));
    expect(byId(six.rows, github.id)).toMatchObject({ off: false, mark: null });

    // 7: no build, no job, in the session -> off, kept
    const seven = presetRows(r, from({ session: new Set([dbKey]) }));
    expect(byId(seven.rows, dbServer.id)).toMatchObject({ off: true, mark: 'kept', key: dbKey });
    // 8: not in the session -> on
    expect(byId(seven.rows, github.id)).toMatchObject({ off: false, mark: null });
    expect(seven.warnings).toEqual([]);
  });

  it('a saved job that omits what the session switched off shows it on, as the job says (R10.2)', () => {
    const r = resolved([github]);
    const { rows } = presetRows(r, from({ session: new Set([github.id]), job: noGiven }));
    expect(rows[0]).toMatchObject({ off: false, mark: null });
  });

  it("a saved job's choice for a locked item is ignored with a warning", () => {
    const { rows, warnings } = presetRows(resolved([kataAsk]), from({ job: { ...noGiven, tool_servers: ['kata:tool-server:kata-ask'] } }));
    expect(rows[0].off).toBe(false);
    expect(rows[0].locked).toEqual(KATA_LOCK);
    expect(warnings).toEqual(['The job switches off `kata-ask`; its choice was ignored: the run needs it to ask you questions']);
  });

  it('a missing job entry adds a warning naming it', () => {
    const { warnings } = presetRows(resolved([github], ['personal:plugin:gone@market']), from({ job: noGiven }));
    expect(warnings).toEqual(['This job switches off `gone@market`, which is no longer installed; the run starts without it.']);
  });

  it("a follower takes its plugin's result and mark, and never warns", () => {
    const plugin = item('plugin', 'personal', 'sp@m');
    const follower = item('skill', 'plugin', 'sp@m:brainstorming', { brought_by: plugin.id, lock: { kind: 'follows-plugin', plugin: plugin.id } });
    const { rows, warnings } = presetRows(resolved([plugin, follower]), from({ job: { ...noGiven, plugins: [plugin.id], skills: [follower.id] } }));
    expect(byId(rows, follower.id)).toMatchObject({ off: true, mark: 'job' });
    expect(byId(rows, plugin.id)).toMatchObject({ off: true, mark: 'job' });
    expect(warnings).toEqual([]);
  });
});

describe('toGiven', () => {
  it('toGiven drops locked rows and followers and always returns a section', () => {
    expect(toGiven([])).toEqual(noGiven);
    const plugin = item('plugin', 'personal', 'sp@m');
    const follower = item('skill', 'plugin', 'sp@m:b', { brought_by: plugin.id, lock: { kind: 'follows-plugin', plugin: plugin.id } });
    const rows = presetRows(resolved([github, dbServer, kataAsk, plugin, follower]), from({
      session: new Set([givenKey(dbServer.id, WORKDIR), github.id, plugin.id, kataAsk.id]),
    })).rows;
    expect(toGiven(rows)).toEqual({
      hooks: [], skills: [], plugins: [plugin.id], instructions: [],
      tool_servers: [dbServer.id, github.id].sort(),
    });
  });
});

describe('toggle', () => {
  const plugin = item('plugin', 'personal', 'sp@m');
  const follower = item('skill', 'plugin', 'sp@m:b', { brought_by: plugin.id, lock: { kind: 'follows-plugin', plugin: plugin.id } });
  const other = item('skill', 'plugin', 'x@m:c', { brought_by: 'personal:plugin:x@m', lock: { kind: 'follows-plugin', plugin: 'personal:plugin:x@m' } });
  const rows = presetRows(resolved([plugin, follower, other, kataAsk]), from()).rows;

  it('toggle carries followers with their plugin and leaves locked rows alone', () => {
    const off = toggle(rows, plugin.id, true);
    expect(byId(off, plugin.id).off).toBe(true);
    expect(byId(off, follower.id).off).toBe(true);
    expect(byId(off, other.id).off).toBe(false);
    expect(byId(toggle(off, plugin.id, false), follower.id).off).toBe(false);
    expect(rows.every((r) => !r.off)).toBe(true);

    expect(toggle(rows, kataAsk.id, true)).toEqual(rows);
    expect(toggle(rows, follower.id, true)).toEqual(rows);
    expect(toggle(rows, 'nope', true)).toEqual(rows);
  });
});

describe('rows that go off with a hook', () => {
  const lint = item('hook', 'project', 'lint', { name: 'lint' });
  const fmt = item('hook', 'project', 'fmt', { name: 'fmt' });
  const sub = item('instruction', 'project', 'sub/CLAUDE.md', { name: 'sub/CLAUDE.md', goes_off_with: [lint.id, fmt.id] });
  const lintKey = givenKey(lint.id, WORKDIR);
  const fmtKey = givenKey(fmt.id, WORKDIR);
  const rows = presetRows(resolved([lint, fmt, sub]), from()).rows;

  it('toggle recomputes rows that go off with a hook', () => {
    const off = toggle(rows, lintKey, true);
    expect(byId(off, sub.id)).toMatchObject({ off: true, offWith: 'lint' });
    // The first hook in list order names the reason, and the row stays off until every hook is back on.
    const both = toggle(off, fmtKey, true);
    expect(byId(both, sub.id)).toMatchObject({ off: true, offWith: 'lint' });
    const lintBack = toggle(both, lintKey, false);
    expect(byId(lintBack, sub.id)).toMatchObject({ off: true, offWith: 'fmt' });
    const back = toggle(lintBack, fmtKey, false);
    expect(byId(back, sub.id)).toMatchObject({ off: false });
    expect(byId(back, sub.id).offWith ?? null).toBeNull();
    // While a hook is off the row cannot be switched on by itself.
    expect(byId(toggle(off, givenKey(sub.id, WORKDIR), false), sub.id).off).toBe(true);
  });

  it('presetRows starts a row off when its hook starts off', () => {
    const preset = presetRows(resolved([lint, fmt, sub]), from({ session: new Set([lintKey]) })).rows;
    expect(byId(preset, sub.id)).toMatchObject({ off: true, offWith: 'lint' });
  });

  it('toGiven leaves out rows that go off with a hook', () => {
    const off = toggle(rows, lintKey, true);
    expect(toGiven(off)).toEqual({ ...noGiven, hooks: [lint.id] });
    // An instruction the engineer switched off themselves, with its hooks on, is still listed.
    const own = toggle(rows, givenKey(sub.id, WORKDIR), true);
    expect(toGiven(own)).toEqual({ ...noGiven, instructions: [sub.id] });
  });
});

describe('groupRows', () => {
  it('groupRows counts items and switched-off items per group', () => {
    const plugin = item('plugin', 'personal', 'sp@m');
    const follower = item('skill', 'plugin', 'sp@m:b', { brought_by: plugin.id, lock: { kind: 'follows-plugin', plugin: plugin.id } });
    const skillA = item('skill', 'personal', 'a');
    const skillB = item('skill', 'personal', 'b');
    const skillP = item('skill', 'project', 'p');
    const rows = presetRows(resolved([skillA, skillB, skillP, plugin, follower, github, kataAsk]), from({
      session: new Set([skillA.id, plugin.id]),
    })).rows;
    const groups = groupRows(rows);
    expect(groups.map((g) => g.kind)).toEqual(['skill', 'plugin', 'tool-server']);
    expect(groups.map((g) => g.label)).toEqual(['Skills', 'Plugins', 'Tool servers']);

    const skills = groups[0];
    expect(skills.groups.map((g) => g.source)).toEqual(['personal', 'project']);
    expect(skills.groups[0]).toMatchObject({ count: 2, off: 1 });
    expect(skills.groups[0].rows.map((e) => e.row.item.id)).toEqual([skillA.id, skillB.id]);
    expect(skills).toMatchObject({ count: 3, off: 1 });

    const plugins = groups[1];
    expect(plugins).toMatchObject({ count: 1, off: 1 });
    expect(plugins.groups[0].rows[0].row.item.id).toBe(plugin.id);
    expect(plugins.groups[0].rows[0].followers.map((f) => f.item.id)).toEqual([follower.id]);

    expect(groups[2].groups.map((g) => g.source)).toEqual(['personal', 'kata']);
    expect(groups[2]).toMatchObject({ count: 2, off: 0 });
  });
});

describe('settingSourceLabel', () => {
  it('settingSourceLabel per source and mode', () => {
    expect(settingSourceLabel('run-spec', 'workbench')).toBe('the job');
    expect(settingSourceLabel('run-spec', 'sdlc')).toBe('Kata itself');
    expect(settingSourceLabel('kata-default', 'workbench')).toBe('Kata itself');
    expect(settingSourceLabel('personal', 'sdlc')).toBe('personal setup');
    expect(settingSourceLabel('project', 'workbench')).toBe('project');
    expect(settingSourceLabel('project-local', 'workbench')).toBe('project');
    expect(settingSourceLabel('organization', 'workbench')).toBe('your organization');
    expect(settingSourceLabel('claude-default', 'workbench')).toBe("Claude's default");
    expect(settingSourceLabel('claude-report', 'workbench')).toBe('reported by Claude');
  });
});

describe('modeOf', () => {
  const { type: _type, ...recorded } = runGivenFixture;
  it("modeOf reads the record's options", () => {
    expect(modeOf({ ...recorded, options: { required_plugins: ['ai-sdlc'], build: true } })).toBe('sdlc');
    expect(modeOf({ ...recorded, options: { required_plugins: ['ai-sdlc'], build: false } })).toBe('sdlc');
    expect(modeOf({ ...recorded, options: { required_plugins: [], build: false } })).toBe('workbench');
    expect(modeOf(recorded)).toBe('workbench');
  });
});

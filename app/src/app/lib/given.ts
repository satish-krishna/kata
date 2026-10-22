/* What a run is given: how a choice is keyed, which rows a preview starts from,
 * and how rows are grouped and labeled. Pure; no Angular, no I/O. */

import type { Given } from '@bindings/Given';
import type { ItemKind } from '@bindings/ItemKind';
import type { LockReason } from '@bindings/LockReason';
import type { Mode } from '@bindings/Mode';
import type { Resolved } from '@bindings/Resolved';
import type { ResolvedItem } from '@bindings/ResolvedItem';
import type { SettingSource } from '@bindings/SettingSource';
import type { Source } from '@bindings/Source';

export type PresetFrom = {
  workdir: string;
  session: ReadonlySet<string>;
  job: Given | null;
  build: ReadonlySet<string> | null;
};
export type PresetMark = 'kept' | 'job' | 'build' | null;
export type PresetRow = { item: ResolvedItem; key: string; off: boolean; locked: LockReason | null; mark: PresetMark };
export type PresetResult = { rows: PresetRow[]; warnings: string[] };

export type RowEntry = { row: PresetRow; followers: PresetRow[] };
export type SourceGroup = { source: Source; rows: RowEntry[]; count: number; off: number };
export type KindGroup = { kind: ItemKind; label: string; groups: SourceGroup[]; count: number; off: number };

const PROJECT_SOURCES: readonly string[] = ['project', 'project-local'];
const KIND_ORDER: readonly ItemKind[] = ['hook', 'skill', 'plugin', 'instruction', 'tool-server'];
const KIND_LABELS: Record<ItemKind, string> = {
  hook: 'Hooks',
  skill: 'Skills',
  plugin: 'Plugins',
  instruction: 'Standing instructions',
  'tool-server': 'Tool servers',
};
const SOURCE_ORDER: readonly Source[] = ['personal', 'project', 'project-local', 'plugin', 'organization', 'kata', 'run-spec'];

const isFollower = (item: ResolvedItem): boolean => item.lock?.kind === 'follows-plugin';

/** How a choice is keyed across runs: a project item is qualified by the folder it came from. */
export function givenKey(id: string, workdir: string): string {
  if (!PROJECT_SOURCES.includes(id.split(':')[0])) return id;
  const dir = workdir
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  return `${dir}|${id}`;
}

/** The name part of an id (everything after `<source>:<kind>:`), for an item that is no longer installed. */
function nameOfId(id: string): string {
  return id.split(':').slice(2).join(':') || id;
}

function listedInJob(given: Given): Set<string> {
  return new Set([...given.hooks, ...given.skills, ...given.plugins, ...given.instructions, ...given.tool_servers]);
}

/** The rows a preview starts from, and the warnings that go with them. */
export function presetRows(resolved: Resolved, from: PresetFrom): PresetResult {
  const warnings: string[] = [];
  const jobIds = from.job ? listedInJob(from.job) : null;
  const decide = (item: ResolvedItem): PresetRow => {
    const key = givenKey(item.id, from.workdir);
    const row: PresetRow = { item, key, off: false, locked: item.lock, mark: null };
    if (item.lock) {
      const listed = (jobIds?.has(item.id) ?? false) || (from.build?.has(key) ?? false);
      if (listed && item.lock.kind !== 'follows-plugin') {
        warnings.push(`The job switches off \`${item.name}\`; its choice was ignored: ${item.lock.text}`);
      }
      return row;
    }
    if (from.build) return from.build.has(key) ? { ...row, off: true, mark: 'build' } : row;
    if (jobIds) return jobIds.has(item.id) ? { ...row, off: true, mark: 'job' } : row;
    return from.session.has(key) ? { ...row, off: true, mark: 'kept' } : row;
  };

  const decided = new Map<string, PresetRow>();
  for (const item of resolved.items) if (!isFollower(item)) decided.set(item.id, decide(item));
  const rows = resolved.items.map((item): PresetRow => {
    const own = decided.get(item.id);
    if (own) return own;
    const plugin = item.lock?.kind === 'follows-plugin' ? decided.get(item.lock.plugin) : undefined;
    return { item, key: givenKey(item.id, from.workdir), off: plugin?.off ?? false, locked: item.lock, mark: plugin?.mark ?? null };
  });
  for (const id of resolved.missing) {
    warnings.push(`This job switches off \`${nameOfId(id)}\`, which is no longer installed; the run starts without it.`);
  }
  return { rows, warnings };
}

const isSwitchable = (row: PresetRow): boolean => row.locked === null && row.item.brought_by === null;

/** The run-spec's `given` section for these rows: the switched-off, switchable items. Always a section. */
export function toGiven(rows: readonly PresetRow[]): Given {
  const given: Given = { hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [] };
  const lists: Record<ItemKind, string[]> = {
    hook: given.hooks,
    skill: given.skills,
    plugin: given.plugins,
    instruction: given.instructions,
    'tool-server': given.tool_servers,
  };
  for (const row of rows) if (row.off && isSwitchable(row)) lists[row.item.kind].push(row.item.id);
  for (const list of Object.values(lists)) list.sort();
  return given;
}

/** Switch one row; a plugin takes its followers with it. A locked row or a follower is left alone. */
export function toggle(rows: readonly PresetRow[], key: string, off: boolean): PresetRow[] {
  const target = rows.find((r) => r.key === key);
  if (!target || !isSwitchable(target)) return [...rows];
  return rows.map((r) => {
    if (r === target) return { ...r, off };
    const follows = r.item.lock?.kind === 'follows-plugin' && r.item.lock.plugin === target.item.id;
    return follows ? { ...r, off } : r;
  });
}

/** Rows by kind, then source; followers sit under their plugin. Counts cover top-level rows only. */
export function groupRows(rows: readonly PresetRow[]): KindGroup[] {
  const present = new Set(rows.map((r) => r.item.id));
  const followersOf = new Map<string, PresetRow[]>();
  const top: PresetRow[] = [];
  for (const row of rows) {
    const parent = row.item.brought_by;
    if (parent !== null && present.has(parent)) followersOf.set(parent, [...(followersOf.get(parent) ?? []), row]);
    else top.push(row);
  }
  const result: KindGroup[] = [];
  for (const kind of KIND_ORDER) {
    const groups: SourceGroup[] = [];
    for (const source of SOURCE_ORDER) {
      const entries = top
        .filter((r) => r.item.kind === kind && r.item.source === source)
        .map((row): RowEntry => ({ row, followers: followersOf.get(row.item.id) ?? [] }));
      if (entries.length > 0) groups.push({ source, rows: entries, count: entries.length, off: entries.filter((e) => e.row.off).length });
    }
    if (groups.length === 0) continue;
    result.push({
      kind,
      label: KIND_LABELS[kind],
      groups,
      count: groups.reduce((n, g) => n + g.count, 0),
      off: groups.reduce((n, g) => n + g.off, 0),
    });
  }
  return result;
}

/** How a setting's source reads next to its value. */
export function settingSourceLabel(source: SettingSource, mode: Mode): string {
  switch (source) {
    case 'run-spec': return mode === 'sdlc' ? 'Kata itself' : 'the job';
    case 'kata-default': return 'Kata itself';
    case 'personal': return 'personal setup';
    case 'project':
    case 'project-local': return 'project';
    case 'organization': return 'your organization';
    case 'claude-default': return "Claude's default";
    case 'claude-report': return 'reported by Claude';
  }
}

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

export function givenKey(_id: string, _workdir: string): string {
  return '';
}

export function presetRows(_resolved: Resolved, _from: PresetFrom): PresetResult {
  return { rows: [], warnings: [] };
}

export function toGiven(_rows: readonly PresetRow[]): Given {
  return { hooks: ['x'], skills: [], plugins: [], instructions: [], tool_servers: [] };
}

export function toggle(rows: readonly PresetRow[], _key: string, _off: boolean): PresetRow[] {
  return [...rows];
}

export function groupRows(_rows: readonly PresetRow[]): KindGroup[] {
  return [{ kind: 'hook', label: '', groups: [], count: -1, off: -1 }];
}

export function settingSourceLabel(_source: SettingSource, _mode: Mode): string {
  return '';
}

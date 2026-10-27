import { Injectable, signal } from '@angular/core';
import type { ChangeInfo } from '@bindings/ChangeInfo';

/** What the home page last saw of one change in this session: its stage or the error that stopped the read, and whether a pass is checking it again. */
export type StageRow = { info: ChangeInfo | null; error: string | null; checking: boolean };

/** One line of the home page's change list: a change folder with whatever the page has read of it so far. */
export type ChangeRow = { system: string; change: string; title: string | null; info: ChangeInfo | null; error: string | null; checking: boolean };

/** The key of a change in `rows`. */
export const stageKey = (system: string, change: string): string => `${system}/${change}`;

const NONE: Readonly<Record<string, StageRow>> = {};

/** Which stages the home page last saw in this session. Memory only: nothing here is ever saved, so a new session starts empty. */
@Injectable({ providedIn: 'root' })
export class SdlcStagesStore {
  private readonly all = signal<Readonly<Record<string, Readonly<Record<string, StageRow>>>>>({});

  /** The workspace's rows by `stageKey`. Reading it inside a computed makes the computed follow the store. */
  rows(workspaceId: string): Readonly<Record<string, StageRow>> {
    return this.all()[workspaceId] ?? NONE;
  }

  /** A fresh stage: it replaces whatever was stored and is no longer being checked. */
  put(workspaceId: string, info: ChangeInfo): void {
    this.set(workspaceId, stageKey(info.system, info.change), { info, error: null, checking: false });
  }

  /** The change could not be read: its error takes the place of its stage. */
  putError(workspaceId: string, system: string, change: string, error: string): void {
    this.set(workspaceId, stageKey(system, change), { info: null, error, checking: false });
  }

  /** A pass starts: every stored row is shown as being checked until its fresh value arrives. */
  markChecking(workspaceId: string): void {
    this.update(workspaceId, (rows) => Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { ...r, checking: true }])));
  }

  /** A pass ended: nothing is being checked any more, including a row the pass never reached. */
  settle(workspaceId: string): void {
    this.update(workspaceId, (rows) => Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, { ...r, checking: false }])));
  }

  /** The workspace was removed. */
  clear(workspaceId: string): void {
    this.all.update(({ [workspaceId]: _gone, ...rest }) => rest);
  }

  private set(workspaceId: string, key: string, row: StageRow): void {
    this.update(workspaceId, (rows) => ({ ...rows, [key]: row }));
  }

  private update(workspaceId: string, change: (rows: Readonly<Record<string, StageRow>>) => Readonly<Record<string, StageRow>>): void {
    this.all.update((all) => ({ ...all, [workspaceId]: change(all[workspaceId] ?? NONE) }));
  }
}

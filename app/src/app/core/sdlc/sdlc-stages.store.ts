import { Injectable } from '@angular/core';
import type { ChangeInfo } from '@bindings/ChangeInfo';

/** What the home page last saw of one change in this session: its stage or the error that stopped the read, and whether a pass is checking it again. */
export type StageRow = { info: ChangeInfo | null; error: string | null; checking: boolean };

/** The key of a change in `rows`. */
export const stageKey = (system: string, change: string): string => `${system}/${change}`;

/** Which stages the home page last saw in this session. Memory only: nothing here is ever saved, so a new session starts empty. */
@Injectable({ providedIn: 'root' })
export class SdlcStagesStore {
  rows(_workspaceId: string): Readonly<Record<string, StageRow>> {
    return {};
  }

  put(_workspaceId: string, _info: ChangeInfo): void {}

  putError(_workspaceId: string, _system: string, _change: string, _error: string): void {}

  markChecking(_workspaceId: string): void {}

  settle(_workspaceId: string): void {}

  clear(_workspaceId: string): void {}
}

/** One line of the home page's change list: a change folder with whatever the page has read of it so far. */
export type ChangeRow = { system: string; change: string; title: string | null; info: ChangeInfo | null; error: string | null; checking: boolean };

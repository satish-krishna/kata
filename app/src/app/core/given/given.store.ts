import { Injectable, signal } from '@angular/core';
import type { PresetRow } from '../../lib/given';

export type BuildChoices = { off: ReadonlySet<string> };

/** Where the session's and each build's choices are kept: in memory only, gone when the Workbench closes. */
@Injectable({ providedIn: 'root' })
export class GivenStore {
  private readonly keys = signal<ReadonlySet<string>>(new Set());

  readonly session = this.keys.asReadonly();

  remember(_rows: readonly PresetRow[], _workdir: string): void {}

  build(_key: string): BuildChoices | null {
    return null;
  }

  setBuild(_key: string, _choices: BuildChoices): void {}
}

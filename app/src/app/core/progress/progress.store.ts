import { Injectable, Signal, signal } from '@angular/core';
import type { ProgressStepId } from '../../lib/progress-steps';

/** What a progress line shows: the playful line (or the plain long-run notice) and the plain label that never rotates. */
export type ProgressView = { line: string; label: string; long: boolean };

export const DEFAULT_OWNER = 'page';

/** The one progress entry of each place on screen (an owner), shown by `ProgressLine`. */
@Injectable({ providedIn: 'root' })
export class ProgressStore {
  begin(_step: ProgressStepId, _plain: string, _owner: string = DEFAULT_OWNER): void {}
  update(_plain: string, _owner: string = DEFAULT_OWNER): void {}
  end(_owner: string = DEFAULT_OWNER): void {}
  fail(_owner: string = DEFAULT_OWNER): void {}
  view(_owner: string = DEFAULT_OWNER): Signal<ProgressView | null> {
    return signal<ProgressView | null>(null).asReadonly();
  }
}

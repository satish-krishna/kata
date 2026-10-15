import { Injectable } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';

export type LaunchPayload = { spec: RunSpec; autorun: boolean };

/** One-shot handoff from the Library to Compose: set just before navigating,
 *  taken once when the Workbench screen initializes. Not reactive on purpose. */
@Injectable({ providedIn: 'root' })
export class LaunchStore {
  private pending: LaunchPayload | null = null;
  set(payload: LaunchPayload): void { this.pending = payload; }
  take(): LaunchPayload | null { const v = this.pending; this.pending = null; return v; }
}

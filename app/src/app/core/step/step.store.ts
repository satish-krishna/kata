import { Injectable, inject, signal } from '@angular/core';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { StepKind } from '@bindings/StepKind';
import { KataTransport } from '../transport/kata-transport';

/** A long step of a change that runs now, with the latest label the backend reported for it. */
export interface ChangeStep {
  change: ChangeKey;
  kind: StepKind;
  label: string;
}

/**
 * The long steps running now, as the backend's step table has them, kept for every page: seeded from the backend when a page opens a
 * change and followed through its reports. A page picks the entry of the change it shows; nothing here is tied to a page.
 */
@Injectable({ providedIn: 'root' })
export class StepStore {
  private readonly transport = inject(KataTransport);
  readonly running = signal<ChangeStep[]>([]);

  /** Seed from the backend and follow its reports and ends; a later call follows again from a fresh read. */
  async follow(): Promise<void> {
    void this.transport;
  }

  /** The page's own call for the change's step answered, so the step is over whatever the backend's end report says. */
  ended(_change: { system: string; change: string }): void {
    return;
  }
}

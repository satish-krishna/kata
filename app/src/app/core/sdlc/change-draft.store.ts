import { Injectable } from '@angular/core';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { Pick } from '../../lib/build-sessions';

/** What the engineer left on a change's page, as form state only: no decision about the change is kept here. */
@Injectable({ providedIn: 'root' })
export class ChangeDraftStore {
  /** The message typed for a run, or an empty string. */
  message(_ref: ChangeRef, _run: string): string {
    return '';
  }

  /** Remember the message typed for a run; empty text forgets it. */
  setMessage(_ref: ChangeRef, _run: string, _text: string): void {}

  /** The message was sent: its draft is gone. */
  clearMessage(_ref: ChangeRef, _run: string): void {}

  /** The document tab the engineer had open, or null. */
  tab(_ref: ChangeRef): string | null {
    return null;
  }

  setTab(_ref: ChangeRef, _tab: string | null): void {}

  /** The run, task or review the engineer picked on the build page, or null. */
  pick(_ref: ChangeRef): Pick | null {
    return null;
  }

  setPick(_ref: ChangeRef, _pick: Pick | null): void {}
}

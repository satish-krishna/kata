import { Injectable, signal } from '@angular/core';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { LayoutMode } from '../../lib/build-layout';
import type { Pick } from '../../lib/build-sessions';
import { changeRunKey } from '../run/change-run.store';

type Draft = {
  /** The message typed for each run, by run. */
  messages: Readonly<Record<string, string>>;
  tab: string | null;
  pick: Pick | null;
};

const EMPTY: Draft = { messages: {}, tab: null, pick: null };

/**
 * What the engineer left on a change's page, so coming back to it shows the same thing. Form state only: no decision
 * about the change is kept here, and a draft lives as long as the app does. Changes are keyed as `ChangeRunStore` keys them.
 */
@Injectable({ providedIn: 'root' })
export class ChangeDraftStore {
  private readonly all = signal<Readonly<Record<string, Draft>>>({});

  /** Every message typed on the change's page, by run. */
  messages(ref: ChangeRef): Readonly<Record<string, string>> {
    return this.of(ref).messages;
  }

  /** The message typed for a run, or an empty string. */
  message(ref: ChangeRef, run: string): string {
    return this.of(ref).messages[run] ?? '';
  }

  /** Remember the message typed for a run; empty text forgets it. */
  setMessage(ref: ChangeRef, run: string, text: string): void {
    const { [run]: _gone, ...rest } = this.of(ref).messages;
    this.put(ref, { messages: text === '' ? rest : { ...rest, [run]: text } });
  }

  /** The message was sent: its draft is gone. */
  clearMessage(ref: ChangeRef, run: string): void {
    this.setMessage(ref, run, '');
  }

  /** The document tab the engineer had open, or null. */
  tab(ref: ChangeRef): string | null {
    return this.of(ref).tab;
  }

  setTab(ref: ChangeRef, tab: string | null): void {
    this.put(ref, { tab });
  }

  /** The run, task or review the engineer picked on the build page, or null. */
  pick(ref: ChangeRef): Pick | null {
    return this.of(ref).pick;
  }

  setPick(ref: ChangeRef, pick: Pick | null): void {
    this.put(ref, { pick });
  }

  /** The build page's mode the engineer picked, or null. */
  mode(_ref: ChangeRef): LayoutMode | null {
    return null;
  }

  setMode(_ref: ChangeRef, _mode: LayoutMode | null): void {}

  /** The round dialog's picks and notes while it is open, or null. */
  round(_ref: ChangeRef): RoundPicks | null {
    return null;
  }

  setRound(_ref: ChangeRef, _round: RoundPicks | null): void {}

  private of(ref: ChangeRef): Draft {
    return this.all()[changeRunKey(ref)] ?? EMPTY;
  }

  private put(ref: ChangeRef, change: Partial<Draft>): void {
    const key = changeRunKey(ref);
    this.all.update((m) => ({ ...m, [key]: { ...(m[key] ?? EMPTY), ...change } }));
  }
}

import { Injectable, Signal, computed, signal } from '@angular/core';
import { PROGRESS_NAMES, PROGRESS_STEPS, type ProgressStepId } from '../../lib/progress-steps';

/** What a progress line shows: the playful line (or the plain long-run notice) and the plain label that never rotates. */
export type ProgressView = { line: string; label: string; long: boolean };

/** The owner used when a place has no other progress line on its page to clash with. */
export const DEFAULT_OWNER = 'page';

const SHOW_AFTER_MS = 400;
const ROTATE_EVERY_MS = 5_000;
const LONG_AT_LEAST_MS = 10_000;
const TICK_MS = 100;

type Entry = { step: ProgressStepId; label: string; startedAt: number; start: number };

/**
 * The one progress entry of each place on screen, keyed by an owner string so the home page and the lock panel do not
 * clash. A step that ends or fails leaves no entry at all, so a failure's playful line is gone before the caller raises
 * its error. Nothing shows for the first 400 ms; after that the playful line rotates every five seconds from a random
 * start; at three times the step's usual time (and at least ten seconds) a plain notice replaces it.
 */
@Injectable({ providedIn: 'root' })
export class ProgressStore {
  private readonly entries = signal<Readonly<Record<string, Entry>>>({});
  private readonly now = signal(Date.now());
  private readonly views = new Map<string, Signal<ProgressView | null>>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  /** Start the owner's step, replacing whatever it was showing. `plain` is the label that stays put. */
  begin(step: ProgressStepId, plain: string, owner: string = DEFAULT_OWNER): void {
    const { lines } = PROGRESS_STEPS[step];
    const startedAt = Date.now();
    this.now.set(startedAt);
    this.entries.update((all) => ({ ...all, [owner]: { step, label: plain, startedAt, start: Math.floor(Math.random() * lines.length) } }));
    this.ensureTicker();
  }

  /** Change the plain label (for example "5 of 12 changes read") without touching the clock or the rotation. */
  update(plain: string, owner: string = DEFAULT_OWNER): void {
    this.entries.update((all) => (owner in all ? { ...all, [owner]: { ...all[owner], label: plain } } : all));
  }

  /** The step is over. */
  end(owner: string = DEFAULT_OWNER): void {
    this.clear(owner);
  }

  /** The step failed: the entry is cleared at once, so the caller's error shows with no playful line beside it. */
  fail(owner: string = DEFAULT_OWNER): void {
    this.clear(owner);
  }

  /** What the owner's progress line shows right now, or null while nothing should show. */
  view(owner: string = DEFAULT_OWNER): Signal<ProgressView | null> {
    let view = this.views.get(owner);
    if (view === undefined) {
      view = computed(() => {
        const entry = this.entries()[owner];
        return entry === undefined ? null : this.show(entry, this.now());
      });
      this.views.set(owner, view);
    }
    return view;
  }

  private show(entry: Entry, now: number): ProgressView | null {
    const elapsed = Math.max(0, now - entry.startedAt);
    if (elapsed < SHOW_AFTER_MS) return null;
    const { usualMs, lines } = PROGRESS_STEPS[entry.step];
    if (elapsed >= Math.max(3 * usualMs, LONG_AT_LEAST_MS)) {
      return { line: `${PROGRESS_NAMES[entry.step]} is taking longer than usual (${Math.floor(elapsed / 1000)} s)`, label: entry.label, long: true };
    }
    const at = (entry.start + Math.floor(elapsed / ROTATE_EVERY_MS)) % lines.length;
    return { line: lines[at], label: entry.label, long: false };
  }

  private clear(owner: string): void {
    this.entries.update((all) => {
      if (!(owner in all)) return all;
      const { [owner]: _gone, ...rest } = all;
      return rest;
    });
    if (Object.keys(this.entries()).length === 0 && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private ensureTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => this.now.set(Date.now()), TICK_MS);
  }
}

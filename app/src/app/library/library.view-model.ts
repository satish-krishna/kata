import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataLoadFailure } from '@bindings/KataLoadFailure';
import { KataTransport } from '../core/transport/kata-transport';
import { LaunchStore } from '../core/launch/launch.store';
import { ToastStore } from '../core/toast/toast.store';
import { isStreamEvent, statusForExit, type RunDetail, type RunRecord, type RunState } from '../lib/events';
import { kataViews, withTask } from '../lib/katas';
import { pairToolEvents } from '../lib/toolcards';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** Everything the Library screen does: run history, saved katas, the selected
 *  run's detail and event stream, and the Run again / Open in compose handoff. */
@Injectable()
export class LibraryViewModel {
  private readonly transport = inject(KataTransport);
  private readonly launches = inject(LaunchStore);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);

  readonly runs = signal<RunRecord[]>([]);
  private readonly katas = signal<RunSpec[]>([]);
  /** Files in ~/.kata/katas that would not load. Surfaced rather than dropped:
   *  a kata that silently vanishes is worse than one visibly broken. */
  readonly failures = signal<KataLoadFailure[]>([]);
  /** The kata whose task is being edited before a re-run, or null when the editor is closed. */
  readonly editing = signal<RunSpec | null>(null);
  private readonly detail = signal<RunDetail | null>(null);
  readonly selRun = signal<string | null>(null);
  readonly selKata = signal<string | null>(null);

  readonly kataRows = computed(() => kataViews(this.katas(), this.runs()));
  readonly run = computed(() => this.detail()?.record ?? null);
  readonly kataSaved = computed(() => {
    const r = this.run();
    return r !== null && this.katas().some((k) => k.name === r.kata);
  });
  readonly stream = computed(() => {
    const d = this.detail();
    return d ? pairToolEvents(d.events.filter(isStreamEvent)) : null;
  });

  async init(): Promise<void> {
    const [rs, listing] = await Promise.all([this.transport.listRuns(), this.transport.listKatas()]);
    this.runs.set(rs);
    this.katas.set(listing.katas);
    this.failures.set(listing.failures);
    if (this.selRun() === null && rs.length > 0) await this.selectRun(rs[0].id);
  }

  async selectRun(id: string): Promise<void> {
    this.selRun.set(id);
    const r = this.runs().find((x) => x.id === id);
    if (r) this.selKata.set(r.kata);
    const loaded = await this.transport.loadRun(id);
    // Rapid clicks can resolve loadRun calls in any order: apply only if still selected.
    if (this.selRun() === id) this.detail.set(loaded);
  }

  async selectKata(name: string): Promise<void> {
    this.selKata.set(name);
    const latest = this.runs().find((r) => r.kata === name);
    if (latest) {
      await this.selectRun(latest.id);
    } else {
      this.selRun.set(null);
      this.detail.set(null);
    }
  }

  /** Enter or Space activates a role="button" row. */
  onRowKey(e: KeyboardEvent, activate: () => void): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }

  async reRun(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      this.editing.set(await this.transport.loadKata(r.kata));
    } catch (e) {
      this.toasts.error(`Failed to load kata: ${e}`);
    }
  }

  confirmReRun(task: string): void {
    const kata = this.editing();
    if (!kata) return;
    this.launch(withTask(kata, task), true);
    this.editing.set(null);
  }

  cancelReRun(): void {
    this.editing.set(null);
  }

  async openInCompose(): Promise<void> {
    const r = this.run();
    if (!r) return;
    try {
      this.launch(await this.transport.loadKata(r.kata), false);
    } catch (e) {
      this.toasts.error(`Failed to load kata: ${e}`);
    }
  }

  async exportBundle(): Promise<void> {
    const r = this.run();
    if (!r) return;
    const dir = await this.transport.pickDirectory();
    if (!dir) return;
    try {
      await this.transport.exportBundle(await this.transport.loadKata(r.kata), dir);
    } catch (e) {
      this.toasts.error(`Failed to export bundle: ${e}`);
    }
  }

  /** Hand `spec` to the Workbench screen, which takes it on init. */
  private launch(spec: RunSpec, autorun: boolean): void {
    this.launches.set({ spec, autorun });
    void this.router.navigate(['/']);
  }

  stateOf(r: RunRecord): RunState {
    return statusForExit(r.exit ?? null);
  }

  tone(s: RunState): 'success' | 'warning' | 'error' {
    return s === 'success' ? 'success' : s === 'warning' ? 'warning' : 'error';
  }

  statTone(s: RunState): 'success' | 'error' | undefined {
    return s === 'success' ? 'success' : s === 'error' ? 'error' : undefined;
  }

  fmtMs(ms: number | null | undefined): string {
    return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
  }

  fmtCost(c: number | null | undefined): string {
    return c == null ? '—' : `$${c.toFixed(3)}`;
  }

  fmtTurns(t: number | null | undefined): string {
    return t == null ? '—' : `${t}`;
  }

  fmtWhen(secs: number): string {
    const d = new Date(secs * 1000);
    const hh = `${d.getHours()}`.padStart(2, '0');
    const mm = `${d.getMinutes()}`.padStart(2, '0');
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY_MS);
    const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? WEEKDAYS[d.getDay()] : d.toLocaleDateString();
    return `${day} · ${hh}:${mm}`;
  }

  baseName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }
}

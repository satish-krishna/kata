import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { Mode } from '@bindings/Mode';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataLoadFailure } from '@bindings/KataLoadFailure';
import { KataTransport } from '../core/transport/kata-transport';
import { LaunchStore } from '../core/launch/launch.store';
import { ToastStore } from '../core/toast/toast.store';
import { givenFrom, isStreamEvent, messagesFrom, type MessageRecord, statusForExit, type RunGiven, type RunDetail, type RunRecord, type RunState } from '../lib/events';
import { modeOf } from '../lib/given';
import { kataViews, withTask } from '../lib/katas';
import { pairToolEvents, withPauses } from '../lib/toolcards';

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
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap);

  readonly runs = signal<RunRecord[]>([]);
  private readonly katas = signal<RunSpec[]>([]);
  /** Files in ~/.kata/katas that would not load. Surfaced rather than dropped:
   *  a kata that silently vanishes is worse than one visibly broken. */
  readonly failures = signal<KataLoadFailure[]>([]);
  /** The kata whose task is being edited before a re-run, or null when the editor is closed. */
  readonly editing = signal<RunSpec | null>(null);
  private readonly detail = signal<RunDetail | null>(null);
  readonly selRun = signal<string | null>(null);
  /** The mode the selected run was made in, which decides how its settings' sources read. */
  readonly givenMode = computed<Mode>(() => {
    const g = this.given();
    return g && g !== 'not-recorded' ? modeOf(g) : 'workbench';
  });
  /** Whether the dialog showing what the selected run was given is open. */
  readonly givenOpen = signal(false);
  readonly selKata = signal<string | null>(null);

  readonly kataRows = computed(() => kataViews(this.katas(), this.runs()));
  readonly run = computed(() => this.detail()?.record ?? null);
  readonly kataSaved = computed(() => {
    const r = this.run();
    return r !== null && this.katas().some((k) => k.name === r.kata);
  });
  /** What the selected run was given, read from its transcript; null when no run is open. */
  readonly given = computed<RunGiven | 'not-recorded' | null>(() => {
    const d = this.detail();
    return d ? givenFrom(d.events) : null;
  });
  readonly stream = computed(() => {
    const d = this.detail();
    return d ? withPauses(pairToolEvents(d.events.filter(isStreamEvent)), [], [], this.messages()) : null;
  });

  /** The messages the operator sent into the selected run, placed by their position in the transcript. */
  readonly messages = computed<MessageRecord[]>(() => messagesFrom(this.detail()?.events ?? []));

  openGiven(): void {
    this.givenOpen.set(true);
  }

  closeGiven(): void {
    this.givenOpen.set(false);
  }

  /** Escape and a backdrop click close the overlay from inside. */
  onGivenState(state: BrnDialogState): void {
    if (state === 'closed') this.givenOpen.set(false);
  }

  async init(): Promise<void> {
    const [rs, listing] = await Promise.all([this.transport.listRuns(), this.transport.listKatas()]);
    this.runs.set(rs);
    this.katas.set(listing.katas);
    this.failures.set(listing.failures);
    if (this.selRun() !== null || rs.length === 0) return;
    // A run named by `?run=` is the one to show; naming one that is not in the history shows none rather than the newest.
    const wanted = this.query()?.get('run') ?? null;
    if (wanted === null) await this.selectRun(rs[0].id);
    else if (rs.some((r) => r.id === wanted)) await this.selectRun(wanted);
  }

  async selectRun(id: string): Promise<void> {
    this.selRun.set(id);
    this.givenOpen.set(false);
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

  /** Local wall-clock time, HH:MM:SS, of a millisecond epoch. */
  fmtClock(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => `${n}`.padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  baseName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }
}

import { computed, signal } from '@angular/core';
import type { BuildStatus } from '@bindings/BuildStatus';

export interface RunEnd {
  exit: number | null;
  error: string | null;
}

export interface RunOptions {
  timeoutSecs: number;
  instructions?: string;
  signal: AbortSignal;
}

export type RunTarget = { repo: string } | 'review';

export interface BuildDriverDeps {
  status: () => Promise<BuildStatus>;
  start: (target: RunTarget, opts: RunOptions) => Promise<RunEnd>;
  heads: () => Promise<Record<string, string>>;
}

export type BuildPhase = 'building' | 'reviewing' | 'stopped' | 'finished' | 'cancelled';

export interface WaitingRepo {
  repo: string;
  task: string;
  onTask: string;
  onRepo: string;
}

export interface StopReport {
  unfinished: { repo: string; tasks: string[] }[];
  waiting: WaitingRepo[];
}

export class BuildDriver {
  readonly going = signal<ReadonlySet<string>>(new Set());
  readonly stopped = signal<ReadonlyMap<string, { task: string; reason: string }>>(new Map());
  readonly round = signal<{ repo: string; instructions: string } | null>(null);
  readonly phase = signal<BuildPhase>('building');
  readonly waiting = signal<WaitingRepo[]>([]);
  readonly report = signal<StopReport | null>(null);
  readonly busy = computed(() => this.going().size > 0);

  constructor(private readonly deps: BuildDriverDeps) {}

  async begin(_timeoutSecs: number, _round?: { repo: string; instructions: string }): Promise<void> {}
  async continueRepo(_repo: string): Promise<void> {}
  async continueAll(): Promise<void> {}
  cancel(_repo: string): void {}
  cancelAll(): void {}
}

import { Injectable, signal } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { AskRecord, PermissionRecord, RunState, RunSummary, StreamEvent } from '../../lib/events';
import type { Finding } from '../../lib/sdlc';
import type { RepoRow } from '../../ui/repo-status-list';
import type { ReplacedFindings } from '../../ui/findings-list';
import type { BuildHandoff } from '../change/change-page.view-model';
import type { BuildPhase, StopReport } from './build-driver';

/** What the build runs against: the workspace, the system and the change. */
export type BuildContext = { workspaceId: string; folder: string; system: string; change: string };

/** One run of the selected repository, as the observe pane shows it. */
export type ShownRun = {
  id: string;
  startedAt: string;
  spec: RunSpec;
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
};

@Injectable()
export class BuildViewModel {
  readonly rows = signal<RepoRow[]>([]);
  readonly selected = signal<string | null>(null);
  readonly tasksLabel = signal('');
  readonly phase = signal<BuildPhase>('building');
  readonly active = signal(false);
  readonly shown = signal<ShownRun[]>([]);
  readonly action = signal<'cancel' | 'continue' | null>(null);
  readonly report = signal<StopReport | null>(null);
  readonly findings = signal<Finding[]>([]);
  readonly replaced = signal<ReplacedFindings[]>([]);
  readonly closeBlocked = signal(false);

  async start(_handoff: BuildHandoff, _ctx: BuildContext): Promise<boolean> {
    return false;
  }
  select(_name: string): void {}
  cancelBuild(): void {}
  cancelRun(): void {}
  async continueRun(): Promise<void> {}
  answer(_runId: string, _e: { id: string; answers: string[][] }): void {}
  decide(_runId: string, _e: { id: string; allow: boolean; message: string | null }): void {}
  async close(): Promise<void> {}
}

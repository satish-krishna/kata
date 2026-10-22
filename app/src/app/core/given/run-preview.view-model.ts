import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import type { Mode } from '@bindings/Mode';
import type { RunSetting } from '@bindings/RunSetting';
import type { RunSettings } from '@bindings/RunSettings';
import type { RunSpec } from '@bindings/RunSpec';
import { groupRows, itemSourceLabel, presetRows, settingSourceLabel, toGiven, toggle, type PresetFrom, type PresetRow } from '../../lib/given';
import { SDLC_REQUIRED_PLUGINS } from '../../lib/sdlc';
import type { PreviewEnvRow, PreviewSection, PreviewSettingRow } from '../../ui/run-preview-dialog';
import { KataTransport } from '../transport/kata-transport';
import { GivenStore } from './given.store';

export type PreviewRequest = {
  spec: RunSpec;
  mode: 'run' | 'sdlc';
  workdir: string;
  /** What the preview starts from; the workdir is the request's own. */
  from: Omit<PresetFrom, 'workdir'>;
};

/** Seconds as `45 s`, `30 min`, `1 h 30 min`. */
export function duration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 60) return `${secs} s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : '', s > 0 ? `${s} s` : ''].filter(Boolean).join(' ');
}

/** The eight settings of a run, each as a value and where it comes from. A limit nobody set reads "none". */
export function settingRows(settings: RunSettings, mode: Mode): PreviewSettingRow[] {
  const row = (label: string, s: RunSetting, show: (v: string) => string, unset: string): PreviewSettingRow => ({
    label,
    value: s.value === null ? unset : show(s.value),
    source: settingSourceLabel(s.source, mode),
  });
  const same = (v: string) => v;
  const secs = (v: string) => duration(Number(v));
  return [
    row('Model', settings.model, same, 'default'),
    row('Effort level', settings.effort, same, 'default'),
    row('Permission posture', settings.permission_posture, same, 'none'),
    row('Empty room', settings.empty_room, same, 'none'),
    row('Answer deadline', settings.answer_deadline, secs, 'waits until answered'),
    row('Time limit', settings.time_limit, secs, 'none'),
    row('Turn cap', settings.turn_cap, same, 'none'),
    row('Spending ceiling', settings.spending_ceiling, (v) => `$${v}`, 'none'),
  ];
}

export type BuildPreviewResult = { off: ReadonlySet<string>; request: unknown };

type Pending = { spec: RunSpec; workdir: string; resolve: (spec: RunSpec | null) => void; reject: (e: unknown) => void };

/** The preview before a run: what the run will be given and run with, and the engineer's choices on it. */
@Injectable()
export class RunPreviewViewModel {
  private readonly transport = inject(KataTransport);
  private readonly givens = inject(GivenStore);

  private readonly rows = signal<PresetRow[]>([]);
  private pending: Pending | null = null;
  private token = 0;

  readonly isOpen = signal(false);
  readonly busy = signal(false);
  readonly title = signal('Run preview');
  readonly settings = signal<PreviewSettingRow[]>([]);
  readonly env = signal<PreviewEnvRow[]>([]);
  readonly warnings = signal<string[]>([]);
  readonly groups = computed(() => groupRows(this.rows()));

  /** Open the preview; resolves with the run-spec to run (its `given` set from the switches) or null when cancelled. */
  open(req: PreviewRequest): Promise<RunSpec | null> {
    this.close(null);
    const token = ++this.token;
    const result = new Promise<RunSpec | null>((resolve, reject) => {
      this.pending = { spec: req.spec, workdir: req.workdir, resolve, reject };
    });
    this.isOpen.set(true);
    this.busy.set(true);
    this.transport.previewRun(req.spec, req.mode === 'sdlc' ? SDLC_REQUIRED_PLUGINS : []).then(
      (resolved) => {
        if (token !== this.token) return;
        const preset = presetRows(resolved, { ...req.from, workdir: req.workdir });
        this.rows.set(preset.rows);
        this.warnings.set(preset.warnings);
        this.settings.set(settingRows(resolved.settings, req.mode === 'sdlc' ? 'sdlc' : 'workbench'));
        this.env.set(resolved.env.map((e) => ({ name: e.name, source: itemSourceLabel(e.source), apiKey: e.api_key })));
        this.busy.set(false);
      },
      (error: unknown) => {
        if (token !== this.token) return;
        const failed = this.pending;
        this.pending = null;
        this.close(null);
        failed?.reject(error);
      },
    );
    return result;
  }

  readonly buildForm = signal<{ model: WritableSignal<any>; form: any } | null>(null);
  readonly sections = signal<PreviewSection[] | null>(null);
  readonly safetyRules = signal<string[] | null>(null);
  readonly canStart = computed(() => true);
  openBuild(_req: { from: Omit<PresetFrom, 'workdir'> }): Promise<BuildPreviewResult | null> {
    return Promise.resolve(null);
  }

  toggle(key: string, off: boolean): void {
    this.rows.update((rows) => toggle(rows, key, off));
  }

  start(): void {
    const pending = this.pending;
    if (!pending || this.busy()) return;
    this.givens.remember(this.rows(), pending.workdir);
    const spec = { ...pending.spec, given: toGiven(this.rows()) };
    this.close(spec);
  }

  cancel(): void {
    this.close(null);
  }

  private close(result: RunSpec | null): void {
    const pending = this.pending;
    this.pending = null;
    this.token++;
    this.isOpen.set(false);
    this.busy.set(false);
    this.rows.set([]);
    this.settings.set([]);
    this.env.set([]);
    this.warnings.set([]);
    pending?.resolve(result);
  }
}

import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import type { Mode } from '@bindings/Mode';
import type { RunSetting } from '@bindings/RunSetting';
import type { RunSettings } from '@bindings/RunSettings';
import type { RunSpec } from '@bindings/RunSpec';
import { groupRows, itemSourceLabel, presetRows, settingSourceLabel, toGiven, toggle, type PresetFrom, type PresetRow } from '../../lib/given';
import { SDLC_REQUIRED_PLUGINS, buildPreviewFor, safetyRules, type BuildPreviewKind, type BuildPreviewPlan } from '../../lib/sdlc';
import { buildRequest, createBuildForm, limitSecs, type BuildDialogMode, type BuildFormState, type BuildStartRequest } from '../../ui/build-dialog';
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

/** One folder a build runs in: a product repository or, with `repo` null, the master repository for the review. */
export type BuildSectionRequest = { title: string; repo: string | null; spec: RunSpec; workdir: string };

export type BuildPreviewRequest = {
  title: string;
  kind: BuildPreviewKind;
  sections: BuildSectionRequest[];
  from: Omit<PresetFrom, 'workdir'>;
  /** The limit shown when the preview has no time-limit field of its own: the build's, or Kata's review limit. */
  limitSecs: number;
};

/** What the engineer confirmed: the keys switched off for the build, and the time limit or round the fields asked for. */
export type BuildPreviewResult = { off: ReadonlySet<string>; request: BuildStartRequest | null };

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

/** Where a build's shown time limit comes from, in the words next to it. */
const LIMIT_SOURCE_LABELS: Record<BuildPreviewPlan['limitSource'], string> = {
  engineer: 'set in this preview',
  build: "the build's",
  kata: 'Kata itself',
};

type Pending = { spec: RunSpec; workdir: string; resolve: (spec: RunSpec | null) => void; reject: (e: unknown) => void };
type BuildPending = { resolve: (result: BuildPreviewResult | null) => void; reject: (e: unknown) => void };
type Part = { section: BuildSectionRequest; rows: PresetRow[] };

const isSwitchable = (row: PresetRow): boolean => row.locked === null && row.item.brought_by === null;

/** The ids of the rows that belong to the folder they were resolved in: a project item, and what a project plugin brings. */
function projectBound(rows: readonly PresetRow[]): Set<string> {
  const bound = new Set(rows.filter((r) => r.key !== r.item.id).map((r) => r.item.id));
  for (const r of rows) if (r.item.brought_by !== null && bound.has(r.item.brought_by)) bound.add(r.item.id);
  return bound;
}

/** The preview before a run: what the run will be given and run with, and the engineer's choices on it. */
@Injectable()
export class RunPreviewViewModel {
  private readonly transport = inject(KataTransport);
  private readonly givens = inject(GivenStore);
  private readonly injector = inject(Injector);

  private readonly rows = signal<PresetRow[]>([]);
  private readonly parts = signal<Part[]>([]);
  private readonly baseSettings = signal<PreviewSettingRow[]>([]);
  private readonly buildReq = signal<BuildPreviewRequest | null>(null);
  private pending: Pending | null = null;
  private buildPending: BuildPending | null = null;
  private token = 0;

  readonly isOpen = signal(false);
  readonly busy = signal(false);
  readonly title = signal('Run preview');
  readonly env = signal<PreviewEnvRow[]>([]);
  readonly warnings = signal<string[]>([]);

  /** A build's time-limit and round fields; null when the preview asks for neither. */
  readonly buildForm = signal<BuildFormState | null>(null);
  /** The build's safety rules, read-only; null for a run that has none. */
  readonly safetyRules = signal<string[] | null>(null);

  /** The settings, with a build's time limit shown as the field holds it (or as the build or Kata sets it) and labeled by where it comes from. */
  readonly settings = computed<PreviewSettingRow[]>(() => {
    const req = this.buildReq();
    const base = this.baseSettings();
    if (!req) return base;
    const plan = buildPreviewFor(req.kind);
    const form = this.buildForm();
    const secs = form ? limitSecs(form) : req.limitSecs;
    return base.map((s) => (s.label === 'Time limit' ? { ...s, value: duration(secs), source: LIMIT_SOURCE_LABELS[plan.limitSource] } : s));
  });

  /** The rows every run is given: the whole list for a run, and for a build the items that are not tied to one folder, once. */
  readonly groups = computed(() => {
    if (!this.buildReq()) return groupRows(this.rows());
    const parts = this.parts();
    if (parts.length === 0) return [];
    const bound = projectBound(parts[0].rows);
    return groupRows(parts[0].rows.filter((r) => !bound.has(r.item.id)));
  });

  /** A build's folders, each with the project items of that folder; null outside a build preview. For a round only the picked repository shows. */
  readonly sections = computed<PreviewSection[] | null>(() => {
    const req = this.buildReq();
    if (!req) return null;
    const plan = buildPreviewFor(req.kind);
    const picked = plan.asksRound ? (this.buildForm()?.model().repo ?? '') : null;
    return this.parts()
      .filter((p) => picked === null || p.section.repo === picked)
      .map((p) => {
        const bound = projectBound(p.rows);
        return { title: p.section.title, groups: groupRows(p.rows.filter((r) => bound.has(r.item.id))) };
      });
  });

  /** Start run is available once the rows are in and the build's fields hold a valid time limit and round. */
  readonly canStart = computed(() => !this.busy() && (this.buildForm()?.form().valid() ?? true));

  /**
   * Open the preview; resolves with the run-spec to run (its `given` set from the switches) or null when cancelled.
   * A build's request opens the build's preview and resolves with the build's choices.
   */
  open(req: BuildPreviewRequest): Promise<BuildPreviewResult | null>;
  open(req: PreviewRequest): Promise<RunSpec | null>;
  open(req: PreviewRequest | BuildPreviewRequest): Promise<RunSpec | BuildPreviewResult | null> {
    if ('sections' in req) return this.openBuild(req);
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
        this.baseSettings.set(settingRows(resolved.settings, req.mode === 'sdlc' ? 'sdlc' : 'workbench'));
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

  /**
   * Open the preview of a build: one resolution per folder the build runs in, shared items once, each folder's project items
   * under it. Resolves with the build's choices, or null when cancelled.
   */
  openBuild(req: BuildPreviewRequest): Promise<BuildPreviewResult | null> {
    this.close(null);
    const token = ++this.token;
    const plan = buildPreviewFor(req.kind);
    const result = new Promise<BuildPreviewResult | null>((resolve, reject) => {
      this.buildPending = { resolve, reject };
    });
    this.buildReq.set(req);
    this.buildForm.set(plan.asksTimeLimit ? createBuildForm(this.injector, plan.asksRound) : null);
    this.safetyRules.set(safetyRules(req.kind === 'manual-review' ? 'review' : 'repo'));
    this.title.set(req.title);
    this.isOpen.set(true);
    this.busy.set(true);
    Promise.all(req.sections.map((s) => this.transport.previewRun(s.spec, SDLC_REQUIRED_PLUGINS))).then(
      (all) => {
        if (token !== this.token) return;
        const preset = all.map((resolved, i) => presetRows(resolved, { ...req.from, workdir: req.sections[i].workdir }));
        this.parts.set(preset.map((p, i): Part => ({ section: req.sections[i], rows: p.rows })));
        this.warnings.set([...new Set(preset.flatMap((p) => p.warnings))]);
        this.baseSettings.set(settingRows(all[0].settings, 'sdlc'));
        this.env.set(all[0].env.map((e) => ({ name: e.name, source: itemSourceLabel(e.source), apiKey: e.api_key })));
        this.busy.set(false);
      },
      (error: unknown) => {
        if (token !== this.token) return;
        const failed = this.buildPending;
        this.buildPending = null;
        this.close(null);
        failed?.reject(error);
      },
    );
    return result;
  }

  toggle(key: string, off: boolean): void {
    this.rows.update((rows) => toggle(rows, key, off));
    // A shared key is in every folder's rows, so one switch reaches them all; a project key is in one folder's only.
    this.parts.update((parts) => parts.map((p) => ({ ...p, rows: toggle(p.rows, key, off) })));
  }

  start(): void {
    if (!this.canStart()) return;
    if (this.buildPending) {
      this.startBuild();
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    this.givens.remember(this.rows(), pending.workdir);
    const spec = { ...pending.spec, given: toGiven(this.rows()) };
    this.close(spec);
  }

  cancel(): void {
    this.close(null);
  }

  private startBuild(): void {
    const req = this.buildReq();
    const pending = this.buildPending;
    if (!req || !pending) return;
    const rows = this.parts().flatMap((p) => p.rows);
    this.givens.remember(rows, '');
    const off = new Set<string>();
    const listed = new Set<string>();
    for (const row of rows) {
      if (!isSwitchable(row)) continue;
      listed.add(row.key);
      if (row.off) off.add(row.key);
    }
    // A choice for an item this preview does not list (another repository's, on a one-repository preview) stays as it was.
    for (const key of req.from.build ?? []) if (!listed.has(key)) off.add(key);
    const form = this.buildForm();
    const request = form ? buildRequest(form, buildPreviewFor(req.kind).asksRound) : null;
    this.buildPending = null;
    this.reset();
    pending.resolve({ off, request });
  }

  private close(result: RunSpec | null): void {
    const pending = this.pending;
    const build = this.buildPending;
    this.pending = null;
    this.buildPending = null;
    this.reset();
    pending?.resolve(result);
    build?.resolve(null);
  }

  private reset(): void {
    this.token++;
    this.isOpen.set(false);
    this.busy.set(false);
    this.title.set('Run preview');
    this.rows.set([]);
    this.parts.set([]);
    this.baseSettings.set([]);
    this.buildReq.set(null);
    this.buildForm.set(null);
    this.safetyRules.set(null);
    this.env.set([]);
    this.warnings.set([]);
  }
}

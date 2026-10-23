import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import type { Given } from '@bindings/Given';
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import { KataTransport } from '../core/transport/kata-transport';
import { RunStore } from '../core/run/run.store';
import { ToastStore } from '../core/toast/toast.store';
import { LaunchStore } from '../core/launch/launch.store';
import { ModeStore } from '../core/mode/mode.store';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { defaultSpec, draftFrom, normalize, specEquals } from '../lib/spec';
import { isLockedOn, toGiven } from '../lib/given';
import { GivenStore } from '../core/given/given.store';
import { inTauri, seedSpec } from '../lib/mock';

const CATALOG_DEBOUNCE_MS = 300;
const VALIDATE_DEBOUNCE_MS = 200;

/** Everything the Workbench screen does: the draft run-spec and its Signal Forms
 *  tree, dirty tracking against the last-saved snapshot, live validation, the
 *  kit catalog, and the open/save/export/run orchestration. */
@Injectable()
export class WorkbenchViewModel {
  private readonly transport = inject(KataTransport);
  private readonly runs = inject(RunStore);
  private readonly toasts = inject(ToastStore);
  private readonly launches = inject(LaunchStore);
  private readonly modes = inject(ModeStore);
  private readonly givens = inject(GivenStore);
  /** The preview every run goes through; the template mounts its dialog. */
  readonly preview = inject(RunPreviewViewModel);

  // Real Tauri app opens a blank New spec; browser dev/review seeds the example.
  private readonly initial = inTauri() ? defaultSpec() : seedSpec();
  readonly spec = signal<RunSpec>(structuredClone(this.initial));
  readonly form = form(this.spec);
  /** Normalized snapshot of the last load or save. Dirty is snapshot-based because the compose
   *  pane writes through the form's root value, which the form's own dirty() does not see. */
  private readonly saved = signal<RunSpec>(normalize(this.initial));
  readonly dirty = computed(() => !specEquals(normalize(this.spec()), this.saved()));

  readonly catalog = signal<CatalogEntry[]>([]);
  readonly presets = signal<Preset[]>([]);
  readonly errors = signal<string[]>([]);
  readonly valid = computed(() => this.errors().length === 0);

  readonly runState = this.runs.state;
  readonly events = this.runs.events;
  readonly summary = this.runs.summary;
  readonly asks = this.runs.asks;
  readonly permissions = this.runs.permissions;
  readonly given = this.runs.given;
  readonly running = computed(() => this.runState() === 'running' || this.runState() === 'awaiting');

  /** The action waiting behind the "Discard unsaved changes?" confirm, or null when it is closed. */
  private readonly pendingDiscard = signal<(() => void | Promise<void>) | null>(null);
  /** The run-spec of the last confirmed preview, with the `given` it was confirmed with. Not part of the draft, so confirming never makes it dirty. */
  private confirmed: { spec: RunSpec; given: Given } | null = null;
  readonly confirmOpen = computed(() => this.pendingDiscard() !== null);
  /** Whether ComposePane's save-as-preset name prompt is open. */
  readonly naming = signal(false);

  constructor() {
    const workdir = computed(() => this.spec().workdir);
    effect((onCleanup) => {
      const dir = workdir();
      const t = setTimeout(() => void this.loadCatalog(dir), CATALOG_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(t));
    });
    effect((onCleanup) => {
      const snapshot = normalize(this.spec());
      const t = setTimeout(() => void this.revalidate(snapshot), VALIDATE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(t));
    });
  }

  private async loadCatalog(workdir: string): Promise<void> {
    try {
      this.catalog.set(await this.transport.catalog(workdir.trim() === '' ? null : workdir));
    } catch (e) {
      console.error('catalog failed', e);
      this.catalog.set([]);
    }
  }

  private async revalidate(snapshot: RunSpec): Promise<void> {
    try {
      this.errors.set(await this.transport.validateSpec(await this.withoutLocked(snapshot)));
    } catch (e) {
      console.error('validate failed', e);
      this.errors.set([]);
    }
  }

  /** The draft as validation sees it: the entries of its `given` that name a locked item removed. The run ignores them too
   *  (the preview says so), so they must not stop it; the draft itself, and the job's file, keep them until the engineer saves. */
  private async withoutLocked(spec: RunSpec): Promise<RunSpec> {
    const given = spec.given;
    if (!given) return spec;
    const listed = [...given.hooks, ...given.skills, ...given.plugins, ...given.instructions, ...given.tool_servers];
    if (listed.length === 0) return spec;
    try {
      const resolved = await this.transport.previewRun(spec);
      const locked = new Set(resolved.items.filter(isLockedOn).map((i) => i.id));
      if (!listed.some((id) => locked.has(id))) return spec;
      const keep = (ids: string[]) => ids.filter((id) => !locked.has(id));
      return {
        ...spec,
        given: { ...given, hooks: keep(given.hooks), skills: keep(given.skills), plugins: keep(given.plugins), instructions: keep(given.instructions), tool_servers: keep(given.tool_servers) },
      };
    } catch (e) {
      console.error('resolve for validation failed', e);
      return spec;
    }
  }

  /** Replace the draft with `next` and mark it as the saved baseline. */
  private load(next: RunSpec): void {
    this.spec.set(next);
    this.saved.set(normalize(next));
  }

  async init(demo: boolean): Promise<void> {
    try {
      this.presets.set(await this.transport.listPresets());
    } catch (e) {
      console.error('listPresets failed', e);
      this.presets.set([]);
    }
    // Browser dev/review only: ?demo=run auto-starts the scripted run, through the preview like any other run. Never fires under Tauri.
    if (!inTauri() && demo) await this.run();
    const handoff = this.launches.take();
    if (handoff) {
      this.load(draftFrom(handoff.spec));
      if (handoff.autorun) await this.autorun();
    }
  }

  /** Run `action` now when there are no unsaved changes; otherwise defer it behind the confirm. */
  private async guardDiscard(action: () => void | Promise<void>): Promise<void> {
    if (!this.dirty()) {
      await action();
      return;
    }
    this.pendingDiscard.set(action);
  }

  confirmDiscard(): void {
    const action = this.pendingDiscard();
    this.pendingDiscard.set(null);
    if (action) void action();
  }

  cancelDiscard(): void {
    this.pendingDiscard.set(null);
  }

  newSpec(): void {
    void this.guardDiscard(() => this.load(defaultSpec()));
  }

  open(): Promise<void> {
    return this.guardDiscard(async () => {
      const path = await this.transport.pickOpenSpec();
      if (!path) return;
      try {
        this.load(draftFrom(await this.transport.loadSpec(path)));
      } catch (e) {
        this.toasts.error(`Failed to load spec: ${e}`);
      }
    });
  }

  /** The draft as it is saved: with the `given` of the last confirmed preview of this same job, else its own, else an empty one. */
  private forSave(): RunSpec {
    const draft = normalize(this.spec());
    const last = this.confirmed;
    const given = last && specEquals({ ...draft, given: undefined }, { ...last.spec, given: undefined }) ? last.given : (draft.given ?? toGiven([]));
    return { ...draft, given };
  }

  async save(): Promise<void> {
    try {
      await this.transport.saveKata(this.forSave());
      this.saved.set(normalize(this.spec()));
    } catch (e) {
      this.toasts.error(`Failed to save kata: ${e}`);
    }
  }

  async export(): Promise<void> {
    const dir = await this.transport.pickDirectory();
    if (!dir) return;
    try {
      await this.transport.exportBundle(normalize(this.spec()), dir);
    } catch (e) {
      this.toasts.error(`Failed to export bundle: ${e}`);
    }
  }

  async pickWorkdir(): Promise<void> {
    const dir = await this.transport.pickDirectory();
    if (dir) this.form.workdir().value.set(dir);
  }

  setNaming(open: boolean): void {
    this.naming.set(open);
  }

  private runnable(): boolean {
    return this.valid() && !this.running() && !this.confirmOpen() && !this.naming() && !this.preview.isOpen();
  }

  /** Same gate as the original page: the debounced validity, no active run, no dialog open. Opens the preview; the run starts only when it is confirmed. */
  async run(): Promise<void> {
    if (!this.runnable()) return;
    const draft = normalize(this.spec());
    const spec = await this.preview.open({
      spec: draft,
      mode: 'run',
      workdir: draft.workdir,
      from: { session: this.givens.session(), job: draft.given ?? null, build: null },
    });
    if (!spec) return;
    this.confirmed = { spec: draft, given: spec.given ?? toGiven([]) };
    await this.runs.startRun(normalize(spec));
  }

  /** The Library handoff re-validates fresh: the debounced errors cannot have caught up with a just-loaded spec. */
  private async autorun(): Promise<void> {
    try {
      const spec = normalize(this.spec());
      this.errors.set(await this.transport.validateSpec(await this.withoutLocked(spec)));
      if (this.valid()) await this.run();
    } catch (e) {
      this.toasts.error(`Failed to validate spec: ${e}`);
    }
  }

  cancel(): void {
    void this.runs.cancelRun();
  }

  switchMode(): void {
    void this.modes.switchTo('sdlc').catch((e) => this.toasts.error(`Failed to switch mode: ${e}`));
  }

  async savePreset(p: { name: string; body: string }): Promise<void> {
    try {
      await this.transport.savePreset(p.name, p.body);
      this.presets.set(await this.transport.listPresets());
    } catch (e) {
      this.toasts.error(`Failed to save preset: ${e}`);
    }
  }

  answer(e: { id: string; answers: string[][] }): void {
    void this.runs.submitAnswer(e.id, e.answers);
  }

  decide(e: { id: string; allow: boolean; message: string | null }): void {
    void this.runs.submitDecision(e.id, e.allow, e.message);
  }

  /** Ctrl/Cmd+Enter runs the spec, unless a run is active or a dialog is open. */
  onKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    e.preventDefault();
    void this.run();
  }
}

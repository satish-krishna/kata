import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import type { ContextState } from '@bindings/ContextState';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { Snapshot } from '@bindings/Snapshot';
import type { Leftovers } from '@bindings/Leftovers';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Decision } from '@bindings/Decision';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { RunLink } from '@bindings/RunLink';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, validateLocal, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import { MOCK_SDLC_CATALOG, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, SdlcMock, sdlcSetupScript, sdlcSpecScript } from '../../lib/sdlc-mock';
import type { ZoomStep } from '../../lib/zoom-keys';
import { KataTransport, NO_BACKEND } from './kata-transport';

/** How long the first scan of the demo setup folder takes, long enough to see the checking steps. */
const SETUP_SCAN_MS = 1800;

/** Browser stand-in: fixtures plus the scripted run timeline (head, ask,
 *  mid, permission, tail), unblocked by submitAnswer / submitDecision. */
export class MockTransport extends KataTransport {
  private cb: ((ev: KataEvent) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly sdlc = new SdlcMock();
  /** Which scripted run is live: the Workbench one, or an AI-SDLC one picked by the spec name. */
  private setupScanned = false;
  private script: 'workbench' | 'sdlc-spec' | 'sdlc-setup' = 'workbench';

  private sdlcScript() { return this.script === 'sdlc-setup' ? sdlcSetupScript : sdlcSpecScript; }

  private play(segment: ScriptStep[]): void {
    let acc = 0;
    for (const step of segment) {
      acc += step.delay;
      this.timers.push(setTimeout(() => {
        if (step.ev.type === 'run.completed' && this.script === 'sdlc-setup') this.sdlc.finishSetup();
        this.cb?.(step.ev);
      }, acc));
    }
  }

  catalog(workdir: string | null): Promise<CatalogEntry[]> {
    return Promise.resolve(workdir === MOCK_WORKSPACE_FOLDER ? [...seedCatalog, ...MOCK_SDLC_CATALOG] : seedCatalog);
  }
  listRuns(): Promise<RunRecord[]> { return Promise.resolve(history); }
  loadRun(id: string): Promise<RunDetail> { return Promise.resolve(runDetailFixture(id)); }
  loadSpec(_path: string): Promise<RunSpec> { return Promise.reject(new Error(NO_BACKEND)); }
  saveSpec(_path: string, _spec: RunSpec): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  validateSpec(spec: RunSpec): Promise<string[]> { return Promise.resolve(validateLocal(spec)); }
  listKatas(): Promise<KataListing> { return Promise.resolve({ katas: katasFixture, failures: [] }); }
  loadKata(name: string): Promise<RunSpec> { return Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]); }
  saveKata(_spec: RunSpec): Promise<void> { return Promise.resolve(); }
  listPresets(): Promise<Preset[]> { return Promise.resolve(presetsFixture); }
  savePreset(_name: string, _body: string): Promise<void> { return Promise.resolve(); }
  exportBundle(_spec: RunSpec, _out: string): Promise<void> { return Promise.reject(new Error(NO_BACKEND)); }
  sdlcSettings(): Promise<Settings> { return Promise.resolve(this.sdlc.getSettings()); }
  sdlcSaveSettings(settings: Settings): Promise<void> { this.sdlc.saveSettings(settings); return Promise.resolve(); }
  sdlcWorkspaces(): Promise<WorkspaceEntry[]> { return Promise.resolve(this.sdlc.getWorkspaces()); }
  sdlcSaveWorkspaces(workspaces: WorkspaceEntry[]): Promise<void> { this.sdlc.saveWorkspaces(workspaces); return Promise.resolve(); }
  sdlcScan(folder: string): Promise<WorkspaceScan> {
    // The first scan of the demo folder that needs setup is slow, so the "Checking workspace" steps are visible.
    if (folder === MOCK_SETUP_FOLDER && !this.setupScanned) {
      this.setupScanned = true;
      return new Promise((ok) => setTimeout(() => ok(this.sdlc.scan(folder)), SETUP_SCAN_MS));
    }
    return Promise.resolve(this.sdlc.scan(folder));
  }
  sdlcContextHealth(_folder: string, _master: string, _system: string, repo: string): Promise<ContextState> { return Promise.resolve(this.sdlc.contextHealth(repo)); }
  sdlcChanges(_master: string, _system: string): Promise<ChangeInfo[]> { return Promise.resolve(this.sdlc.listChanges()); }
  sdlcBranches(_master: string): Promise<BranchInfo> { return Promise.resolve(this.sdlc.branches()); }
  sdlcReadDoc(_master: string, _system: string, change: string, doc: string): Promise<string | null> {
    try {
      return Promise.resolve(this.sdlc.readDoc(change, doc));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  sdlcSnapshot(_master: string): Promise<Snapshot> { return Promise.resolve(this.sdlc.snapshot()); }
  sdlcLeftovers(_master: string, _before: Snapshot, _productRepos: string[]): Promise<Leftovers> { return Promise.resolve(this.sdlc.leftovers()); }
  sdlcDiscard(_master: string, _before: Snapshot, paths: string[]): Promise<void> { this.sdlc.discard(paths); return Promise.resolve(); }
  sdlcStartChange(_master: string, _base: string): Promise<string> { return Promise.resolve(this.sdlc.startChange()); }
  sdlcFinishChange(_master: string, _pending: string, base: string): Promise<FinishOutcome> { return Promise.resolve(this.sdlc.finishChange(base)); }
  sdlcCheckout(_master: string, branch: string): Promise<void> { this.sdlc.checkout(branch); return Promise.resolve(); }
  sdlcDecide(_master: string, _system: string, change: string, decision: Decision, _confirmed: boolean): Promise<DecideOutcome> { return Promise.resolve(this.sdlc.decide(change, decision)); }
  sdlcRunLinks(): Promise<RunLink[]> { return Promise.resolve(this.sdlc.runLinks()); }
  sdlcLinkRun(link: RunLink): Promise<void> { this.sdlc.linkRun(link); return Promise.resolve(); }
  /** The scripted run has no process to wait for. */
  sdlcWaitRunExit(_timeoutMs: number): Promise<boolean> { return Promise.resolve(true); }
  /** A plain browser has no window to zoom. */
  zoom(_step: ZoomStep): Promise<number> { return Promise.resolve(1); }
  pickDirectory(): Promise<string | null> { return Promise.resolve(null); }
  pickOpenSpec(): Promise<string | null> { return Promise.resolve(null); }
  pickSaveSpec(): Promise<string | null> { return Promise.resolve(null); }

  async onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void> {
    this.cb = cb;
    return () => { if (this.cb === cb) this.cb = null; };
  }
  async runSpec(spec: RunSpec): Promise<void> {
    if (spec.name.startsWith('sdlc-')) {
      this.script = spec.name === 'sdlc-setup' ? 'sdlc-setup' : 'sdlc-spec';
      this.sdlc.beginRun();
      this.play(this.sdlcScript().head);
      return;
    }
    this.script = 'workbench';
    this.play(runScriptHead);
  }
  async cancelRun(): Promise<void> {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.script !== 'workbench') this.sdlc.cancelRun();
  }
  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    this.cb?.({ type: 'ask.answered', id, answers });
    this.play(this.script === 'workbench' ? runScriptMid : this.sdlcScript().mid);
  }
  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    this.cb?.({ type: 'permission.decided', id, ...PENDING_PERMISSION, allow, decided_by: 'operator', message: message ?? undefined });
    this.play(runScriptTail);
  }
}

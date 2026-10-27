import { TauriTransport, type TauriIpc } from './tauri-transport';
import { seedSpec } from '../../lib/mock';
import type { PublishStep } from '@bindings/PublishStep';
import type { StageEvent } from '@bindings/StageEvent';
import type { KataEvent } from '../../lib/events';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { Snapshot } from '@bindings/Snapshot';
import type { RunLink } from '@bindings/RunLink';
import type { BuildStart } from '@bindings/BuildStart';
import type { PublishRepo } from '@bindings/PublishRepo';

const spec = seedSpec();
const settings: Settings = { mode: 'sdlc', remember: true, permission_mode: 'bypass' };
const entry: WorkspaceEntry = { id: 'w', name: 'w', folder: '/w', base_branch: 'main', last_opened: 1 };
const snap: Snapshot = { head: 'abc', dirty: {} };
const link: RunLink = { workspace_id: 'w', system: 's', change: 'c', stage: 'intent', run_id: 'r', started_at: 1 };
const start: BuildStart = { master: { repo: 'm', path: '/w/m', base: 'main', branch: 'change/c', created: false }, repos: [] };
const publishRepo: PublishRepo = { repo: 'r', path: '/w/r', base: 'main' };
const layout: Record<string, unknown> = { order: ['T1'] };
const FILTERS = [{ name: 'Run-spec', extensions: ['toml', 'json'] }];

function fakeIpc() {
  return {
    invoke: vi.fn(() => Promise.resolve(undefined)),
    listen: vi.fn(() => Promise.resolve(() => undefined)),
    open: vi.fn(() => Promise.resolve('/picked')),
    save: vi.fn(() => Promise.resolve('/saved.toml')),
  };
}
const asIpc = (f: ReturnType<typeof fakeIpc>) => f as unknown as TauriIpc;

type Row = [string, (t: TauriTransport) => unknown, string, Record<string, unknown> | undefined];
const rows: Row[] = [
  ['catalog', (t) => t.catalog('/w'), 'catalog', { workdir: '/w' }],
  ['listRuns', (t) => t.listRuns(), 'list_runs', undefined],
  ['loadRun', (t) => t.loadRun('r1'), 'load_run', { id: 'r1' }],
  ['loadSpec', (t) => t.loadSpec('a.toml'), 'load_spec', { path: 'a.toml' }],
  ['saveSpec', (t) => t.saveSpec('a.toml', spec), 'save_spec', { path: 'a.toml', spec }],
  ['validateSpec', (t) => t.validateSpec(spec), 'validate_spec', { spec }],
  ['previewRun', (t) => t.previewRun(spec), 'preview_run', { spec }],
  ['runSpec', (t) => t.runSpec(spec), 'run_spec', { spec }],
  ['runSpec with a group', (t) => t.runSpec(spec, 'build:claims/c'), 'run_spec', { spec, group: 'build:claims/c' }],
  ['openUrl', (t) => t.openUrl('https://github.com/o/r/pull/1'), 'open_url', { url: 'https://github.com/o/r/pull/1' }],
  ['cancelRun', (t) => t.cancelRun('7'), 'cancel_run', { runId: '7' }],
  ['submitAnswer', (t) => t.submitAnswer('7', 'q', [['a']]), 'submit_answer', { runId: '7', id: 'q', answers: [['a']] }],
  ['submitDecision', (t) => t.submitDecision('7', 'p', true, null), 'submit_decision', { runId: '7', id: 'p', allow: true, message: null }],
  ['listKatas', (t) => t.listKatas(), 'list_katas', undefined],
  ['loadKata', (t) => t.loadKata('k'), 'load_kata', { name: 'k' }],
  ['saveKata', (t) => t.saveKata(spec), 'save_kata', { spec }],
  ['listPresets', (t) => t.listPresets(), 'list_presets', undefined],
  ['savePreset', (t) => t.savePreset('n', 'b'), 'save_preset', { name: 'n', body: 'b' }],
  ['exportBundle', (t) => t.exportBundle(spec, 'out'), 'export_bundle', { spec, out: 'out' }],
  ['sdlcSettings', (t) => t.sdlcSettings(), 'sdlc_settings', undefined],
  ['sdlcSaveSettings', (t) => t.sdlcSaveSettings(settings), 'sdlc_save_settings', { settings }],
  ['sdlcWorkspaces', (t) => t.sdlcWorkspaces(), 'sdlc_workspaces', undefined],
  ['sdlcSaveWorkspaces', (t) => t.sdlcSaveWorkspaces([entry]), 'sdlc_save_workspaces', { workspaces: [entry] }],
  ['sdlcScan', (t) => t.sdlcScan('/w'), 'sdlc_scan', { folder: '/w' }],
  ['sdlcContextHealth', (t) => t.sdlcContextHealth('/w', 'm', 's', 'r'), 'sdlc_context_health', { folder: '/w', master: 'm', system: 's', repo: 'r' }],
  ['sdlcInstructions', (t) => t.sdlcInstructions('/w', 'm'), 'sdlc_instructions', { folder: '/w', masterRepo: 'm' }],
  ['sdlcChanges', (t) => t.sdlcChanges('/m', 's'), 'sdlc_changes', { master: '/m', system: 's' }],
  ['sdlcChangeNames', (t) => t.sdlcChangeNames('/m', 's'), 'sdlc_change_names', { master: '/m', system: 's' }],
  ['sdlcReadStages', (t) => t.sdlcReadStages('/m', 's'), 'sdlc_read_stages', { master: '/m', system: 's' }],
  ['sdlcReadStages with a first change', (t) => t.sdlcReadStages('/m', 's', 'c'), 'sdlc_read_stages', { master: '/m', system: 's', first: 'c' }],
  ['sdlcReadChange', (t) => t.sdlcReadChange('/m', 's', 'c'), 'sdlc_read_change', { master: '/m', system: 's', change: 'c' }],
  ['sdlcMissingFolders', (t) => t.sdlcMissingFolders(['/a', '/b']), 'sdlc_missing_folders', { folders: ['/a', '/b'] }],
  ['sdlcBranches', (t) => t.sdlcBranches('/m'), 'sdlc_branches', { master: '/m' }],
  ['sdlcWaitRunExit', (t) => t.sdlcWaitRunExit('7', 15000), 'sdlc_wait_run_exit', { runId: '7', timeoutMs: 15000 }],
  ['zoom', (t) => t.zoom('in'), 'zoom', { step: 'in' }],
  ['loadBuildLayout', (t) => t.loadBuildLayout(), 'load_build_layout', undefined],
  ['saveBuildLayout', (t) => t.saveBuildLayout(layout), 'save_build_layout', { layout }],
  ['sdlcReadDoc', (t) => t.sdlcReadDoc('/m', 's', 'c', 'intent'), 'sdlc_read_doc', { master: '/m', system: 's', change: 'c', doc: 'intent' }],
  ['sdlcSnapshot', (t) => t.sdlcSnapshot('/m'), 'sdlc_snapshot', { master: '/m' }],
  ['sdlcLeftovers', (t) => t.sdlcLeftovers('/m', snap, ['r']), 'sdlc_leftovers', { master: '/m', before: snap, productRepos: ['r'] }],
  ['sdlcDiscard', (t) => t.sdlcDiscard('/m', snap, ['p']), 'sdlc_discard', { master: '/m', before: snap, paths: ['p'] }],
  ['sdlcLeftovers in a build', (t) => t.sdlcLeftovers('/m', snap, ['r'], { system: 's', change: 'c' }), 'sdlc_leftovers', { master: '/m', before: snap, productRepos: ['r'], build: { system: 's', change: 'c' } }],
  ['sdlcDiscard in a build', (t) => t.sdlcDiscard('/m', snap, ['p'], { system: 's', change: 'c' }), 'sdlc_discard', { master: '/m', before: snap, paths: ['p'], build: { system: 's', change: 'c' } }],
  ['sdlcStartChange', (t) => t.sdlcStartChange('/m', 'main'), 'sdlc_start_change', { master: '/m', base: 'main' }],
  ['sdlcFinishChange', (t) => t.sdlcFinishChange('/m', 'pending', 'main'), 'sdlc_finish_change', { master: '/m', pending: 'pending', base: 'main' }],
  ['sdlcCheckout', (t) => t.sdlcCheckout('/m', 'b'), 'sdlc_checkout', { master: '/m', branch: 'b' }],
  ['sdlcDecide', (t) => t.sdlcDecide('/m', 's', 'c', 'accept-spec', true), 'sdlc_decide', { master: '/m', system: 's', change: 'c', decision: 'accept-spec', confirmed: true }],
  ['sdlcRunLinks', (t) => t.sdlcRunLinks(), 'sdlc_run_links', undefined],
  ['sdlcLinkRun', (t) => t.sdlcLinkRun(link), 'sdlc_link_run', { link }],
  ['sdlcBuildStatus', (t) => t.sdlcBuildStatus('/m', 's', 'c'), 'sdlc_build_status', { master: '/m', system: 's', change: 'c' }],
  ['sdlcReadParsed', (t) => t.sdlcReadParsed('/m', 's', 'c', 'plan'), 'sdlc_read_parsed', { master: '/m', system: 's', change: 'c', doc: 'plan' }],
  ['sdlcReviewRecord', (t) => t.sdlcReviewRecord('/m', 's', 'c'), 'sdlc_review_record', { master: '/m', system: 's', change: 'c' }],
  ['sdlcUnsavedRows', (t) => t.sdlcUnsavedRows('/m', 's', 'c'), 'sdlc_unsaved_rows', { master: '/m', system: 's', change: 'c' }],
  ['sdlcBuildPrepare', (t) => t.sdlcBuildPrepare('/w', 'm', 's', 'c', true, 'r', 'round'), 'sdlc_build_prepare', { folder: '/w', masterRepo: 'm', system: 's', change: 'c', action: 'round', continueWithLeftovers: true, pending: 'r' }],
  ['sdlcBuildPrepare without a pending repository', (t) => t.sdlcBuildPrepare('/w', 'm', 's', 'c', false, null, 'start'), 'sdlc_build_prepare', { folder: '/w', masterRepo: 'm', system: 's', change: 'c', action: 'start', continueWithLeftovers: false, pending: null }],
  ['sdlcBuildParticipants', (t) => t.sdlcBuildParticipants('/w', 'm', 's', 'c', 'r'), 'sdlc_build_participants', { folder: '/w', masterRepo: 'm', system: 's', change: 'c', pending: 'r' }],
  ['sdlcBuildSettle', (t) => t.sdlcBuildSettle(start), 'sdlc_build_settle', { start }],
  ['sdlcBuildHeads', (t) => t.sdlcBuildHeads('/w', ['r'], 'c'), 'sdlc_build_heads', { folder: '/w', repos: ['r'], change: 'c' }],
  ['sdlcPluginReadiness', (t) => t.sdlcPluginReadiness('/p'), 'sdlc_plugin_readiness', { workdir: '/p' }],
  ['sdlcChangeRepos', (t) => t.sdlcChangeRepos('/w', 'm', 's', 'c'), 'sdlc_change_repos', { folder: '/w', masterRepo: 'm', system: 's', change: 'c' }],
  ['sdlcMissingChangeBranches', (t) => t.sdlcMissingChangeBranches('/w', 'm', 's', 'c'), 'sdlc_missing_change_branches', { folder: '/w', masterRepo: 'm', system: 's', change: 'c' }],
  ['sdlcDiffFiles', (t) => t.sdlcDiffFiles('/r', 'whole'), 'sdlc_diff_files', { repoPath: '/r', part: 'whole' }],
  ['sdlcDiffPair', (t) => t.sdlcDiffPair('/r', 'committed', 'a.ts'), 'sdlc_diff_pair', { repoPath: '/r', part: 'committed', path: 'a.ts' }],
  ['sdlcDiffBase', (t) => t.sdlcDiffBase('/r'), 'sdlc_diff_base', { repoPath: '/r' }],
  ['sdlcTouchedRepos', (t) => t.sdlcTouchedRepos('/w', 'm', 's', 'c'), 'sdlc_touched_repos', { folder: '/w', masterRepo: 'm', system: 's', change: 'c' }],
  ['sdlcCommitOffenders', (t) => t.sdlcCommitOffenders('/w', 'm', 's', 'c'), 'sdlc_commit_offenders', { folder: '/w', masterRepo: 'm', system: 's', change: 'c' }],
  ['sdlcChecksDir', (t) => t.sdlcChecksDir(), 'sdlc_checks_dir', undefined],
  ['sdlcChecksLoad', (t) => t.sdlcChecksLoad('/w', 'm', 's'), 'sdlc_checks_load', { folder: '/w', masterRepo: 'm', system: 's' }],
  ['sdlcRunChecks', (t) => t.sdlcRunChecks('/w', 'm', 's', publishRepo), 'sdlc_run_checks', { folder: '/w', masterRepo: 'm', system: 's', repo: publishRepo }],
  ['sdlcGhSignedIn', (t) => t.sdlcGhSignedIn([publishRepo]), 'sdlc_gh_signed_in', { repos: [publishRepo] }],
  ['sdlcGhOrigins', (t) => t.sdlcGhOrigins([publishRepo]), 'sdlc_gh_origins', { repos: [publishRepo] }],
  ['sdlcPublish', (t) => t.sdlcPublish('/w', 'w1', 'm', 's', 'c', [publishRepo]), 'sdlc_publish', { folder: '/w', workspaceId: 'w1', masterRepo: 'm', system: 's', change: 'c', repos: [publishRepo] }],
  ['sdlcDoneView', (t) => t.sdlcDoneView('/w', 'm', 'w1', 's', 'c', true), 'sdlc_done_view', { folder: '/w', masterRepo: 'm', workspaceId: 'w1', system: 's', change: 'c', buildFinished: true }],
  ['sdlcRefreshPrStates', (t) => t.sdlcRefreshPrStates('/w', 'm', 'w1', 's', 'c', false), 'sdlc_refresh_pr_states', { folder: '/w', masterRepo: 'm', workspaceId: 'w1', system: 's', change: 'c', buildFinished: false }],
  ['sdlcPullRequests', (t) => t.sdlcPullRequests([publishRepo], 'c'), 'sdlc_pull_requests', { repos: [publishRepo], change: 'c' }],
];

describe('TauriTransport', () => {
  it.each(rows)('%s invokes the right command', async (_name, call, cmd, payload) => {
    const ipc = fakeIpc();
    await call(new TauriTransport(asIpc(ipc)));
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    const args = ipc.invoke.mock.calls[0] as unknown[];
    expect(args[0]).toBe(cmd);
    expect(args[1]).toEqual(payload);
  });

  it("returns the program's message when it cannot read a document, never null (F4)", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockRejectedValueOnce('front matter is not closed');
    const t = new TauriTransport(asIpc(ipc));
    expect(await t.sdlcReadParsed('/m', 's', 'c', 'spec')).toEqual({ kind: 'error', message: 'front matter is not closed' });
    ipc.invoke.mockRejectedValueOnce(new Error('node is missing'));
    expect(await t.sdlcReadParsed('/m', 's', 'c', 'spec')).toEqual({ kind: 'error', message: 'node is missing' });
  });

  it('opens the native dialogs with the run-spec filters', async () => {
    const ipc = fakeIpc();
    const t = new TauriTransport(asIpc(ipc));
    expect(await t.pickDirectory()).toBe('/picked');
    expect(ipc.open).toHaveBeenLastCalledWith({ directory: true, multiple: false });
    await t.pickOpenSpec();
    expect(ipc.open).toHaveBeenLastCalledWith({ multiple: false, filters: FILTERS });
    expect(await t.pickSaveSpec()).toBe('/saved.toml');
    expect(ipc.save).toHaveBeenCalledWith({ filters: FILTERS });
  });

  it('unwraps the { runId, event } payload of kata://event and hands the id over as a string', async () => {
    const ipc = fakeIpc();
    const t = new TauriTransport(asIpc(ipc));
    const seen: [string, KataEvent][] = [];
    await t.onRunEvent((runId, e) => seen.push([runId, e]));
    const [event, handler] = ipc.listen.mock.calls[0] as unknown as [string, (e: { payload: { runId: number; event: KataEvent } }) => void];
    expect(event).toBe('kata://event');
    const ev: KataEvent = { type: 'log', level: 'info', message: 'x' };
    handler({ payload: { runId: 3, event: ev } });
    expect(seen).toEqual([['3', ev]]);
  });

  it('hands the payload of sdlc://publish-step over as the step', async () => {
    const ipc = fakeIpc();
    const t = new TauriTransport(asIpc(ipc));
    const seen: PublishStep[] = [];
    await t.onPublishStep((step) => seen.push(step));
    const [event, handler] = ipc.listen.mock.calls[0] as unknown as [string, (e: { payload: PublishStep }) => void];
    expect(event).toBe('sdlc://publish-step');
    handler({ payload: { kind: 'pushing', repo: 'claims-core' } });
    expect(seen).toEqual([{ kind: 'pushing', repo: 'claims-core' }]);
  });

  it('hands the payload of sdlc://stage over as the event', async () => {
    const ipc = fakeIpc();
    const t = new TauriTransport(asIpc(ipc));
    const seen: StageEvent[] = [];
    await t.onStageEvent((ev) => seen.push(ev));
    const [event, handler] = ipc.listen.mock.calls[0] as unknown as [string, (e: { payload: StageEvent }) => void];
    expect(event).toBe('sdlc://stage');
    handler({ payload: { kind: 'progress', pass: 4, read: 1, total: 3 } });
    handler({ payload: { kind: 'done', pass: 4 } });
    expect(seen).toEqual([{ kind: 'progress', pass: 4, read: 1, total: 3 }, { kind: 'done', pass: 4 }]);
  });

  it('runSpec resolves to the run id the backend returned', async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValueOnce('12' as never);
    expect(await new TauriTransport(asIpc(ipc)).runSpec(spec)).toBe('12');
  });
});

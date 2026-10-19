import { TauriTransport, type TauriIpc } from './tauri-transport';
import { seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';
import type { Settings } from '@bindings/Settings';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { Snapshot } from '@bindings/Snapshot';
import type { RunLink } from '@bindings/RunLink';

const spec = seedSpec();
const settings: Settings = { mode: 'sdlc', remember: true, permission_mode: 'bypass' };
const entry: WorkspaceEntry = { id: 'w', name: 'w', folder: '/w', base_branch: 'main', last_opened: 1 };
const snap: Snapshot = { head: 'abc', dirty: {} };
const link: RunLink = { workspace_id: 'w', system: 's', change: 'c', stage: 'intent', run_id: 'r', started_at: 1 };
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
  ['runSpec', (t) => t.runSpec(spec), 'run_spec', { spec }],
  ['cancelRun', (t) => t.cancelRun(), 'cancel_run', undefined],
  ['submitAnswer', (t) => t.submitAnswer('q', [['a']]), 'submit_answer', { id: 'q', answers: [['a']] }],
  ['submitDecision', (t) => t.submitDecision('p', true, null), 'submit_decision', { id: 'p', allow: true, message: null }],
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
  ['sdlcChanges', (t) => t.sdlcChanges('/m', 's'), 'sdlc_changes', { master: '/m', system: 's' }],
  ['sdlcBranches', (t) => t.sdlcBranches('/m'), 'sdlc_branches', { master: '/m' }],
  ['sdlcWaitRunExit', (t) => t.sdlcWaitRunExit(15000), 'sdlc_wait_run_exit', { timeoutMs: 15000 }],
  ['sdlcReadDoc', (t) => t.sdlcReadDoc('/m', 's', 'c', 'intent'), 'sdlc_read_doc', { master: '/m', system: 's', change: 'c', doc: 'intent' }],
  ['sdlcSnapshot', (t) => t.sdlcSnapshot('/m'), 'sdlc_snapshot', { master: '/m' }],
  ['sdlcLeftovers', (t) => t.sdlcLeftovers('/m', snap, ['r']), 'sdlc_leftovers', { master: '/m', before: snap, productRepos: ['r'] }],
  ['sdlcDiscard', (t) => t.sdlcDiscard('/m', snap, ['p']), 'sdlc_discard', { master: '/m', before: snap, paths: ['p'] }],
  ['sdlcStartChange', (t) => t.sdlcStartChange('/m', 'main'), 'sdlc_start_change', { master: '/m', base: 'main' }],
  ['sdlcFinishChange', (t) => t.sdlcFinishChange('/m', 'pending', 'main'), 'sdlc_finish_change', { master: '/m', pending: 'pending', base: 'main' }],
  ['sdlcCheckout', (t) => t.sdlcCheckout('/m', 'b'), 'sdlc_checkout', { master: '/m', branch: 'b' }],
  ['sdlcDecide', (t) => t.sdlcDecide('/m', 's', 'c', 'accept-spec', true), 'sdlc_decide', { master: '/m', system: 's', change: 'c', decision: 'accept-spec', confirmed: true }],
  ['sdlcRunLinks', (t) => t.sdlcRunLinks(), 'sdlc_run_links', undefined],
  ['sdlcLinkRun', (t) => t.sdlcLinkRun(link), 'sdlc_link_run', { link }],
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

  it('forwards the payload of kata://event to the callback', async () => {
    const ipc = fakeIpc();
    const t = new TauriTransport(asIpc(ipc));
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    const [event, handler] = ipc.listen.mock.calls[0] as unknown as [string, (e: { payload: KataEvent }) => void];
    expect(event).toBe('kata://event');
    const ev: KataEvent = { type: 'log', level: 'info', message: 'x' };
    handler({ payload: ev });
    expect(seen).toEqual([ev]);
  });
});

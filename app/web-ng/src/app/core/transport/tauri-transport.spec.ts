import { TauriTransport, type TauriIpc } from './tauri-transport';
import { seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

const spec = seedSpec();
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

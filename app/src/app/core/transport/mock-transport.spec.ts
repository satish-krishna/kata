import { MockTransport } from './mock-transport';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

const total = (steps: { delay: number }[]) => steps.reduce((a, s) => a + s.delay, 0);

describe('MockTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays the head of the scripted run after runSpec', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual(runScriptHead.map((s) => s.ev));
  });

  it('emits ask.answered then plays the middle on submitAnswer', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.submitAnswer('q1', [['yes']]);
    expect(seen[0]).toEqual({ type: 'ask.answered', id: 'q1', answers: [['yes']] });
    vi.advanceTimersByTime(total(runScriptMid));
    expect(seen.slice(1)).toEqual(runScriptMid.map((s) => s.ev));
  });

  it('emits the operator decision then plays the tail on submitDecision', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.submitDecision('p1', false, 'no');
    expect(seen[0]).toEqual({ type: 'permission.decided', id: 'p1', ...PENDING_PERMISSION, allow: false, decided_by: 'operator', message: 'no' });
    vi.advanceTimersByTime(total(runScriptTail));
    expect(seen.length).toBe(1 + runScriptTail.length);
  });

  it('stops the scripted stream on cancelRun', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.runSpec(seedSpec());
    await t.cancelRun();
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual([]);
  });

  it('stops delivering after unlisten', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    const off = await t.onRunEvent((e) => seen.push(e));
    off();
    await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual([]);
  });

  it('rejects backend-only calls with NO_BACKEND', async () => {
    const t = new MockTransport();
    await expect(t.loadSpec('x.toml')).rejects.toThrow(NO_BACKEND);
    await expect(t.saveSpec('x.toml', seedSpec())).rejects.toThrow(NO_BACKEND);
    await expect(t.exportBundle(seedSpec(), 'out')).rejects.toThrow(NO_BACKEND);
  });

  it('resolves pickers to null', async () => {
    const t = new MockTransport();
    expect(await t.pickDirectory()).toBeNull();
    expect(await t.pickOpenSpec()).toBeNull();
    expect(await t.pickSaveSpec()).toBeNull();
  });

  it('accepting the fnol spec moves its change to plan-ready', async () => {
    const t = new MockTransport();
    const before = (await t.sdlcChanges('D:/Work/acme-claims/claims-intent', 'claims')).find((c) => c.change === '2026-10-12-fnol-photo-upload');
    expect(before?.stage).toBe('spec-awaiting');
    const out = await t.sdlcDecide('D:/Work/acme-claims/claims-intent', 'claims', '2026-10-12-fnol-photo-upload', 'accept-spec', false);
    expect(out).toEqual({ kind: 'committed' });
    const after = (await t.sdlcChanges('D:/Work/acme-claims/claims-intent', 'claims')).find((c) => c.change === '2026-10-12-fnol-photo-upload');
    expect(after?.stage).toBe('plan-ready');
  });
});

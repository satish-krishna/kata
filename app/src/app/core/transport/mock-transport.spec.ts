import { MockTransport } from './mock-transport';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';
import { transcriptRunId } from '../../lib/sdlc';
import { MOCK_SETUP_FOLDER, sdlcSetupScript, sdlcSpecScript } from '../../lib/sdlc-mock';

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

  it('checkout records the previous change branch without its prefix and drops the target', async () => {
    const t = new MockTransport();
    await t.sdlcCheckout('/m', 'change/2026-10-17-claim-notes');
    expect(await t.sdlcBranches('/m')).toEqual({ current: 'change/2026-10-17-claim-notes', others: [], default_base: 'main' });
    await t.sdlcCheckout('/m', 'main');
    expect((await t.sdlcBranches('/m')).others).toEqual(['2026-10-17-claim-notes']);
  });

  it('finishing a change renames it once, then deletes a pending branch that created nothing', async () => {
    const t = new MockTransport();
    const pending = await t.sdlcStartChange('/m', 'main');
    const out = await t.sdlcFinishChange('/m', pending, 'main');
    expect(out).toEqual({ renamed: { branch: 'change/2026-10-18-new-change', change: '2026-10-18-new-change' } });
    const b = await t.sdlcBranches('/m');
    expect(b.current).toBe('main');
    expect(b.others).toEqual(['2026-10-17-claim-notes', '2026-10-18-new-change']);
    expect((await t.sdlcChanges('/m', 'claims'))[0].change).toBe('2026-10-18-new-change');

    const again = await t.sdlcStartChange('/m', 'main');
    expect(await t.sdlcFinishChange('/m', again, 'main')).toBe('deleted');
    const after = await t.sdlcBranches('/m');
    expect(after.current).toBe('main');
    expect(after.others).toEqual(b.others);
  });

  it('rejecting an intent moves its change to rejected', async () => {
    const t = new MockTransport();
    expect(await t.sdlcDecide('/m', 'claims', '2026-10-16-fraud-flag', 'reject-intent', false)).toEqual({ kind: 'committed' });
    const c = (await t.sdlcChanges('/m', 'claims')).find((x) => x.change === '2026-10-16-fraud-flag');
    expect(c?.stage).toBe('rejected');
    expect(c?.intent.status).toBe('rejected');
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

  describe('scripted AI-SDLC runs', () => {
    const sdlcSpec = (name: string) => ({ ...seedSpec(), name });

    it('plays the spec script for a sdlc- run: transcript log, the ask, then completion after the answer', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((e) => seen.push(e));
      await t.runSpec(sdlcSpec('sdlc-claims-2026-10-12-fnol-photo-upload-spec'));
      vi.advanceTimersByTime(total(sdlcSpecScript.head));
      expect(seen).toEqual(sdlcSpecScript.head.map((s) => s.ev));
      expect(transcriptRunId(seen)).toBe('sdlc-claims-2026-10-12-fnol-photo-upload-spec-20261018T101500Z');
      const ask = seen.find((e) => e.type === 'ask.requested');
      expect(ask?.type === 'ask.requested' && ask.questions[0].question).toBe('If an upload fails midway, should the claim still be filed without the photos?');
      expect(seen.some((e) => e.type === 'run.completed')).toBe(false);

      await t.submitAnswer('q1', [['Yes']]);
      vi.advanceTimersByTime(total(sdlcSpecScript.mid));
      const done = seen.at(-1);
      expect(done?.type === 'run.completed' && done.exit_code).toBe(0);
    });

    it('plays the setup script when the run is named sdlc-setup', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((e) => seen.push(e));
      await t.runSpec(sdlcSpec('sdlc-setup'));
      vi.advanceTimersByTime(total(sdlcSetupScript.head));
      const ask = seen.find((e) => e.type === 'ask.requested');
      expect(ask?.type === 'ask.requested' && ask.questions[0].question).toBe('Which repo should hold the intent artifacts?');
    });

    it('leaves the Workbench script alone for other names', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((e) => seen.push(e));
      await t.runSpec(sdlcSpec('triage-flaky-test'));
      vi.advanceTimersByTime(total(runScriptHead));
      expect(seen).toEqual(runScriptHead.map((s) => s.ev));
    });

    it('reports leftovers after a cancelled sdlc run, and discarding removes the chosen paths', async () => {
      const t = new MockTransport();
      expect((await t.sdlcLeftovers('/m', { head: null, dirty: {} }, [])).discardable).toEqual([]);
      await t.runSpec(sdlcSpec('sdlc-claims-x-spec'));
      await t.cancelRun();
      const left = await t.sdlcLeftovers('/m', { head: null, dirty: {} }, []);
      expect(left.discardable.length).toBe(2);
      expect(left.touched_dirty.length).toBe(1);
      await t.sdlcDiscard('/m', { head: null, dirty: {} }, left.discardable);
      expect((await t.sdlcLeftovers('/m', { head: null, dirty: {} }, [])).discardable).toEqual([]);
    });

    it('the demo setup folder is not set up until the setup run completes', async () => {
      const t = new MockTransport();
      await t.onRunEvent(() => undefined);
      const scan = async () => {
        const p = t.sdlcScan(MOCK_SETUP_FOLDER);
        await vi.advanceTimersByTimeAsync(2000);
        return p;
      };
      expect((await scan()).marker).toBeNull();
      await t.runSpec(sdlcSpec('sdlc-setup'));
      vi.advanceTimersByTime(total(sdlcSetupScript.head));
      await t.submitAnswer('q1', [['claims-intent']]);
      vi.advanceTimersByTime(total(sdlcSetupScript.mid));
      expect((await scan()).marker).not.toBeNull();
    });
  });
});

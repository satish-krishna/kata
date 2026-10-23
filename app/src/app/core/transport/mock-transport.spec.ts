import { MockTransport } from './mock-transport';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';
import { transcriptRunId } from '../../lib/sdlc';
import type { RunSpec } from '@bindings/RunSpec';
import type { Resolved } from '@bindings/Resolved';
import { MOCK_BUILD_CHANGE, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, sdlcSetupScript, sdlcSpecScript } from '../../lib/sdlc-mock';

const total = (steps: { delay: number }[]) => steps.reduce((a, s) => a + s.delay, 0);

describe('MockTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays the head of the scripted run after runSpec', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual(runScriptHead.map((s) => s.ev));
  });

  it('emits ask.answered then plays the middle on submitAnswer', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    await t.submitAnswer('1', 'q1', [['yes']]);
    expect(seen[0]).toEqual({ type: 'ask.answered', id: 'q1', answers: [['yes']] });
    vi.advanceTimersByTime(total(runScriptMid));
    expect(seen.slice(1)).toEqual(runScriptMid.map((s) => s.ev));
  });

  it('emits the operator decision then plays the tail on submitDecision', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    await t.submitDecision('1', 'p1', false, 'no');
    expect(seen[0]).toEqual({ type: 'permission.decided', id: 'p1', ...PENDING_PERMISSION, allow: false, decided_by: 'operator', message: 'no' });
    vi.advanceTimersByTime(total(runScriptTail));
    expect(seen.length).toBe(1 + runScriptTail.length);
  });

  it('stops the scripted stream on cancelRun', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    const id = await t.runSpec(seedSpec());
    await t.cancelRun(id);
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual([]);
  });

  it('stops delivering after unlisten', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    const off = await t.onRunEvent((_id, e) => seen.push(e));
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

  describe('several scripted runs at once', () => {
    const buildSpec = (repo: string): RunSpec => ({ ...seedSpec(), name: `sdlc-build-${repo}`, workdir: `${MOCK_WORKSPACE_FOLDER}/${repo}` });
    const GROUP = `build:claims/${MOCK_BUILD_CHANGE}`;

    it('gives each run its own id and tags every event with it, interleaved', async () => {
      const t = new MockTransport();
      const seen: [string, KataEvent][] = [];
      await t.onRunEvent((id, e) => seen.push([id, e]));
      const core = await t.runSpec(buildSpec('claims-core'), GROUP);
      const portal = await t.runSpec(buildSpec('customer-portal'), GROUP);
      expect(core).not.toBe(portal);
      vi.advanceTimersByTime(20000);
      const ids = seen.map(([id]) => id);
      expect(new Set(ids)).toEqual(new Set([core, portal]));
      let switches = 0;
      ids.forEach((id, i) => { if (i > 0 && id !== ids[i - 1]) switches++; });
      expect(switches).toBeGreaterThan(2);
      const of = (id: string) => seen.filter(([i]) => i === id).map(([, e]) => e.type);
      expect(of(core)).toContain('run.completed');
      expect(of(portal)).toContain('ask.requested');
      expect(of(portal)).not.toContain('run.completed');
    });

    it('commits each finished run into the build status, and the answer lets the paused run finish', async () => {
      const t = new MockTransport();
      await t.onRunEvent(() => undefined);
      const status = () => t.sdlcBuildStatus('/m', 'claims', MOCK_BUILD_CHANGE);
      expect((await status()).tasks.map((x) => x.row)).toEqual([null, null, null]);
      const core = await t.runSpec(buildSpec('claims-core'), GROUP);
      const portal = await t.runSpec(buildSpec('customer-portal'), GROUP);
      vi.advanceTimersByTime(20000);
      let rows = Object.fromEntries((await status()).tasks.map((x) => [x.id, x.row]));
      expect(rows['T1']?.repo).toBe('claims-core');
      expect(rows['T2']).toBeNull();
      await t.submitAnswer(portal, 'q1', [['Yes']]);
      vi.advanceTimersByTime(20000);
      rows = Object.fromEntries((await status()).tasks.map((x) => [x.id, x.row]));
      expect(rows['T2']?.departure).not.toBeNull();
      expect((await status()).departures.map((d) => d.task)).toEqual(['T2']);
      expect(core).not.toBe(portal);
    });

    it('cancelling one run leaves the other playing', async () => {
      const t = new MockTransport();
      const seen: [string, KataEvent][] = [];
      await t.onRunEvent((id, e) => seen.push([id, e]));
      const core = await t.runSpec(buildSpec('claims-core'), GROUP);
      const portal = await t.runSpec(buildSpec('customer-portal'), GROUP);
      await t.cancelRun(portal);
      vi.advanceTimersByTime(20000);
      expect(seen.some(([id]) => id === portal)).toBe(false);
      expect(seen.some(([id, e]) => id === core && e.type === 'run.completed')).toBe(true);
    });

    it('lists the build-demo change at build-ready', async () => {
      const c = (await new MockTransport().sdlcChanges('/m', 'claims')).find((x) => x.change === MOCK_BUILD_CHANGE);
      expect(c?.stage).toBe('build-ready');
      expect(c?.build).toEqual({ tasks: 3, finished: 0, repos: 2 });
    });
  });

  describe('scripted AI-SDLC runs', () => {
    const sdlcSpec = (name: string) => ({ ...seedSpec(), name });

    it('plays the spec script for a sdlc- run: transcript log, the ask, then completion after the answer', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((_id, e) => seen.push(e));
      const id = await t.runSpec(sdlcSpec('sdlc-claims-2026-10-12-fnol-photo-upload-spec'));
      vi.advanceTimersByTime(total(sdlcSpecScript.head));
      expect(seen).toEqual(sdlcSpecScript.head.map((s) => s.ev));
      expect(transcriptRunId(seen)).toBe('sdlc-claims-2026-10-12-fnol-photo-upload-spec-20261018T101500Z');
      const ask = seen.find((e) => e.type === 'ask.requested');
      expect(ask?.type === 'ask.requested' && ask.questions[0].question).toBe('If an upload fails midway, should the claim still be filed without the photos?');
      expect(seen.some((e) => e.type === 'run.completed')).toBe(false);

      await t.submitAnswer(id, 'q1', [['Yes']]);
      vi.advanceTimersByTime(total(sdlcSpecScript.mid));
      const done = seen.at(-1);
      expect(done?.type === 'run.completed' && done.exit_code).toBe(0);
    });

    it('plays the setup script when the run is named sdlc-setup', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((_id, e) => seen.push(e));
      await t.runSpec(sdlcSpec('sdlc-setup'));
      vi.advanceTimersByTime(total(sdlcSetupScript.head));
      const ask = seen.find((e) => e.type === 'ask.requested');
      expect(ask?.type === 'ask.requested' && ask.questions[0].question).toBe('Which repo should hold the intent artifacts?');
    });

    it('leaves the Workbench script alone for other names', async () => {
      const t = new MockTransport();
      const seen: KataEvent[] = [];
      await t.onRunEvent((_id, e) => seen.push(e));
      await t.runSpec(sdlcSpec('triage-flaky-test'));
      vi.advanceTimersByTime(total(runScriptHead));
      expect(seen).toEqual(runScriptHead.map((s) => s.ev));
    });

    it('reports leftovers after a cancelled sdlc run, and discarding removes the chosen paths', async () => {
      const t = new MockTransport();
      expect((await t.sdlcLeftovers('/m', { head: null, dirty: {} }, [])).discardable).toEqual([]);
      const id = await t.runSpec(sdlcSpec('sdlc-claims-x-spec'));
      await t.cancelRun(id);
      const left = await t.sdlcLeftovers('/m', { head: null, dirty: {} }, []);
      expect(left.discardable.length).toBe(2);
      expect(left.touched_dirty.length).toBe(1);
      await t.sdlcDiscard('/m', { head: null, dirty: {} }, left.discardable);
      expect((await t.sdlcLeftovers('/m', { head: null, dirty: {} }, [])).discardable).toEqual([]);
    });

    it('reads documents by stem and rejects a file name, like the backend contract', async () => {
      const t = new MockTransport();
      expect(await t.sdlcReadDoc('/m', 'claims', '2026-10-12-fnol-photo-upload', 'spec')).toContain('# Spec: photo upload');
      await expect(t.sdlcReadDoc('/m', 'claims', '2026-10-12-fnol-photo-upload', 'spec.md')).rejects.toThrow(/stem/);
    });

    it('has no window to zoom, so the level stays at 100%', async () => {
      expect(await new MockTransport().zoom('in')).toBe(1);
    });

    it('waits for the engine to exit at once', async () => {
      expect(await new MockTransport().sdlcWaitRunExit('1', 15000)).toBe(true);
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
      const id = await t.runSpec(sdlcSpec('sdlc-setup'));
      vi.advanceTimersByTime(total(sdlcSetupScript.head));
      await t.submitAnswer(id, 'q1', [['claims-intent']]);
      vi.advanceTimersByTime(total(sdlcSetupScript.mid));
      expect((await scan()).marker).not.toBeNull();
    });
  });
});

describe('MockTransport previewRun', () => {
  const PAIRS = [
    'hook:personal', 'hook:project', 'hook:plugin', 'hook:organization',
    'skill:personal', 'skill:project', 'skill:plugin', 'skill:run-spec',
    'plugin:personal', 'plugin:project', 'plugin:run-spec',
    'instruction:personal', 'instruction:project', 'instruction:kata', 'instruction:run-spec',
    'tool-server:personal', 'tool-server:project', 'tool-server:plugin', 'tool-server:kata',
  ];

  it('returns every R2.1 pair', async () => {
    const r = await new MockTransport().previewRun(seedSpec());
    const seen = new Set(r.items.map((i) => `${i.kind}:${i.source}`));
    for (const pair of PAIRS) expect(seen, pair).toContain(pair);
    expect(Object.keys(r.settings)).toHaveLength(8);
  });

  it('locks ai-sdlc only when required', async () => {
    const t = new MockTransport();
    const find = (r: Resolved) => r.items.find((i) => i.id === 'personal:plugin:ai-sdlc@ai-sdlc');
    const required = { ...seedSpec(), given: { hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [], required_plugins: ['ai-sdlc'] } };
    expect(find(await t.previewRun(required))?.lock?.kind).toBe('required');
    expect(find(await t.previewRun(seedSpec()))?.lock).toBeNull();
  });

  it('names project items after the last folder of the workdir', async () => {
    const t = new MockTransport();
    const a = await t.previewRun({ ...seedSpec(), workdir: 'D:\ws\alpha' });
    const b = await t.previewRun({ ...seedSpec(), workdir: 'D:\ws\beta' });
    expect(a.items.some((i) => i.source === 'project' && i.name.includes('alpha'))).toBe(true);
    expect(b.items.some((i) => i.name.includes('alpha'))).toBe(false);
  });
});

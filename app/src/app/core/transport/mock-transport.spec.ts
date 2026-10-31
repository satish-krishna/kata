import { MockTransport } from './mock-transport';
import { readAllChanges } from '../../../testing/read-all';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';
import { transcriptRunId } from '../../lib/sdlc';
import type { RunSpec } from '@bindings/RunSpec';
import type { PublishStep } from '@bindings/PublishStep';
import type { StageEvent } from '@bindings/StageEvent';
import type { Resolved } from '@bindings/Resolved';
import { MOCK_BUILD_CHANGE, MOCK_DONE_CHANGE, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, sdlcSetupScript, sdlcSpecScript } from '../../lib/sdlc-mock';

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

  it('opens an address in a new tab with no opener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await new MockTransport().openUrl('https://github.com/o/r/pull/1');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1', '_blank', 'noopener,noreferrer');
    } finally {
      open.mockRestore();
    }
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

  it('sendMessage on a running mock run emits message.sent, then message.read', async () => {
    vi.setSystemTime(1_000_000);
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    const id = await t.runSpec(seedSpec());
    vi.advanceTimersByTime(runScriptHead[0].delay);
    seen.length = 0;
    await t.sendMessage(id, 'm1', 'Stop editing the parser');
    expect(seen).toEqual([{ type: 'message.sent', id: 'm1', text: 'Stop editing the parser', sent_at: 1_000_000 + runScriptHead[0].delay }]);
    vi.advanceTimersByTime(600);
    expect(seen.map((e) => e.type).filter((type) => type.startsWith('message.'))).toEqual(['message.sent', 'message.read']);
    expect(seen.find((e) => e.type === 'message.read')).toMatchObject({ id: 'm1' });
  });

  it('sendMessage while the scripted ask is pending emits message.refused waiting-on-operator', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((_id, e) => seen.push(e));
    const id = await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    seen.length = 0;
    await t.sendMessage(id, 'm1', 'hello');
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([{ type: 'message.refused', id: 'm1', reason: 'waiting-on-operator', text: 'hello' }]);
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
    await t.sdlcCheckout('/m', 'change/2026-10-17-product-notes');
    expect(await t.sdlcBranches('/m')).toEqual({ current: 'change/2026-10-17-product-notes', others: [], default_base: 'main', pending_change: null });
    await t.sdlcCheckout('/m', 'main');
    expect((await t.sdlcBranches('/m')).others.map((o) => o.change)).toEqual(['2026-10-17-product-notes']);
  });

  it('finishing a change renames it once, then deletes a pending branch that created nothing', async () => {
    const t = new MockTransport();
    const pending = await t.sdlcStartChange('/m');
    const out = await t.sdlcFinishChange('/m', pending);
    expect(out).toEqual({ renamed: { branch: 'change/2026-10-18-new-change', change: '2026-10-18-new-change' } });
    const b = await t.sdlcBranches('/m');
    expect(b.current).toBe('main');
    expect(b.others.map((o) => o.change)).toEqual(['2026-10-17-product-notes', '2026-10-18-new-change']);
    expect((await readAllChanges(t))[0].change).toBe('2026-10-18-new-change');

    const again = await t.sdlcStartChange('/m');
    expect(await t.sdlcFinishChange('/m', again)).toBe('deleted');
    const after = await t.sdlcBranches('/m');
    expect(after.current).toBe('main');
    expect(after.others).toEqual(b.others);
  });

  it('rejecting an intent moves its change to rejected', async () => {
    const t = new MockTransport();
    expect(await t.sdlcDecide('/m', 'commerce', '2026-10-16-price-flag', 'reject-intent', false)).toEqual({ kind: 'committed' });
    const c = (await readAllChanges(t)).find((x) => x.change === '2026-10-16-price-flag');
    expect(c?.stage).toBe('rejected');
    expect(c?.intent.status).toBe('rejected');
  });

  it('accepting the photos spec moves its change to plan-ready', async () => {
    const t = new MockTransport();
    const before = (await readAllChanges(t, 'D:/Work/acme-commerce/commerce-docs')).find((c) => c.change === '2026-10-12-product-photo-upload');
    expect(before?.stage).toBe('spec-awaiting');
    const out = await t.sdlcDecide('D:/Work/acme-commerce/commerce-docs', 'commerce', '2026-10-12-product-photo-upload', 'accept-spec', false);
    expect(out).toEqual({ kind: 'committed' });
    const after = (await readAllChanges(t, 'D:/Work/acme-commerce/commerce-docs')).find((c) => c.change === '2026-10-12-product-photo-upload');
    expect(after?.stage).toBe('plan-ready');
  });

  it('shows a change done once every touched repository has a pull request, and refreshing gives the same view', async () => {
    const t = new MockTransport();
    const args = [MOCK_WORKSPACE_FOLDER, 'commerce-docs', 'w1', 'commerce', MOCK_BUILD_CHANGE] as const;
    const before = await t.sdlcDoneView(...args, true);
    expect(before).toMatchObject({ done: false, links: [], offerDeclare: true, prCheckFailed: false });
    const repos = await t.sdlcTouchedRepos(MOCK_WORKSPACE_FOLDER, 'commerce-docs', 'commerce', MOCK_BUILD_CHANGE);
    await t.sdlcPublish(MOCK_WORKSPACE_FOLDER, 'w1', 'commerce-docs', 'commerce', MOCK_BUILD_CHANGE, repos);
    const after = await t.sdlcDoneView(...args, true);
    expect(after.done).toBe(true);
    expect(after.links.map((l) => l.repo)).toEqual(repos.map((r) => r.repo));
    expect(await t.sdlcRefreshPrStates(...args, true)).toEqual(after);
  });

  it('says what publishing is doing, repository by repository, then returns the results', async () => {
    const t = new MockTransport();
    const steps: PublishStep[] = [];
    await t.onPublishStep((step) => steps.push(step));
    const repos = await t.sdlcTouchedRepos(MOCK_WORKSPACE_FOLDER, 'commerce-docs', 'commerce', MOCK_BUILD_CHANGE);
    const summary = await t.sdlcPublish(MOCK_WORKSPACE_FOLDER, 'w1', 'commerce-docs', 'commerce', MOCK_BUILD_CHANGE, repos);
    expect(summary.results).toHaveLength(repos.length);
    expect(steps).toEqual(repos.flatMap((r) => [{ kind: 'pushing', repo: r.repo }, { kind: 'opening', repo: r.repo }]));
  });

  describe('several scripted runs at once', () => {
    const buildSpec = (repo: string): RunSpec => ({ ...seedSpec(), name: `sdlc-build-${repo}`, workdir: `${MOCK_WORKSPACE_FOLDER}/${repo}` });
    const GROUP = `build:commerce/${MOCK_BUILD_CHANGE}`;

    it('gives each run its own id and tags every event with it, interleaved', async () => {
      const t = new MockTransport();
      const seen: [string, KataEvent][] = [];
      await t.onRunEvent((id, e) => seen.push([id, e]));
      const core = await t.runSpec(buildSpec('commerce-core'), GROUP);
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
      const status = () => t.sdlcBuildStatus('/m', 'commerce', MOCK_BUILD_CHANGE);
      expect((await status()).tasks.map((x) => x.row)).toEqual([null, null, null]);
      const core = await t.runSpec(buildSpec('commerce-core'), GROUP);
      const portal = await t.runSpec(buildSpec('customer-portal'), GROUP);
      vi.advanceTimersByTime(20000);
      let rows = Object.fromEntries((await status()).tasks.map((x) => [x.id, x.row]));
      expect(rows['T1']?.repo).toBe('commerce-core');
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
      const core = await t.runSpec(buildSpec('commerce-core'), GROUP);
      const portal = await t.runSpec(buildSpec('customer-portal'), GROUP);
      await t.cancelRun(portal);
      vi.advanceTimersByTime(20000);
      expect(seen.some(([id]) => id === portal)).toBe(false);
      expect(seen.some(([id, e]) => id === core && e.type === 'run.completed')).toBe(true);
    });

    it('lists the build-demo change at build-ready', async () => {
      const c = (await readAllChanges(new MockTransport())).find((x) => x.change === MOCK_BUILD_CHANGE);
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
      const id = await t.runSpec(sdlcSpec('sdlc-commerce-2026-10-12-product-photo-upload-spec'));
      vi.advanceTimersByTime(total(sdlcSpecScript.head));
      expect(seen).toEqual(sdlcSpecScript.head.map((s) => s.ev));
      expect(transcriptRunId(seen)).toBe('sdlc-commerce-2026-10-12-product-photo-upload-spec-20261018T101500Z');
      const ask = seen.find((e) => e.type === 'ask.requested');
      expect(ask?.type === 'ask.requested' && ask.questions[0].question).toBe('If an upload fails midway, should the product still be filed without the photos?');
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
      const id = await t.runSpec(sdlcSpec('sdlc-commerce-x-spec'));
      await t.cancelRun(id);
      const left = await t.sdlcLeftovers('/m', { head: null, dirty: {} }, []);
      expect(left.discardable.length).toBe(2);
      expect(left.touched_dirty.length).toBe(1);
      await t.sdlcDiscard('/m', { head: null, dirty: {} }, left.discardable);
      expect((await t.sdlcLeftovers('/m', { head: null, dirty: {} }, [])).discardable).toEqual([]);
    });

    it('reads documents by stem and rejects a file name, like the backend contract', async () => {
      const t = new MockTransport();
      expect(await t.sdlcReadDoc('/m', 'commerce', '2026-10-12-product-photo-upload', 'spec')).toContain('# Spec: photo upload');
      await expect(t.sdlcReadDoc('/m', 'commerce', '2026-10-12-product-photo-upload', 'spec.md')).rejects.toThrow(/stem/);
    });

    it('keeps the build layout in memory: a fresh mock loads {}, and the next load returns the last save', async () => {
    const t = new MockTransport();
    expect(await t.loadBuildLayout()).toEqual({});
    await t.saveBuildLayout({ order: ['T2'] });
    await t.saveBuildLayout({ order: ['T3', 'T1'] });
    expect(await t.loadBuildLayout()).toEqual({ order: ['T3', 'T1'] });
    expect(await new MockTransport().loadBuildLayout()).toEqual({});
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
      await t.submitAnswer(id, 'q1', [['commerce-docs']]);
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
    const a = await t.previewRun({ ...seedSpec(), workdir: 'D:\\ws\\alpha' });
    const b = await t.previewRun({ ...seedSpec(), workdir: 'D:\\ws\\beta' });
    expect(a.items.some((i) => i.source === 'project' && i.name.includes('alpha'))).toBe(true);
    expect(b.items.some((i) => i.name.includes('alpha'))).toBe(false);
  });

  describe('the two reading passes', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const collect = async (t: MockTransport) => {
      const seen: StageEvent[] = [];
      await t.onStageEvent((e) => seen.push(e));
      return seen;
    };

    it('names every change at once, with no stage read yet', async () => {
      const t = new MockTransport();
      const names = await t.sdlcChangeNames('/m', 'commerce');
      const changes = await readAllChanges(t);
      expect(names.map((n) => n.change)).toEqual(changes.map((c) => c.change));
      expect(names.length).toBeGreaterThan(0);
    });

    it('reads one change in full, and refuses a change it does not have', async () => {
      const t = new MockTransport();
      const [first] = await t.sdlcChangeNames('/m', 'commerce');
      const info = await t.sdlcReadChange('/m', 'commerce', first.change);
      expect(info.change).toBe(first.change);
      expect(info.system).toBe('commerce');
      await expect(t.sdlcReadChange('/m', 'commerce', 'no-such-change')).rejects.toThrow();
    });

    it('reports no folder missing', async () => {
      expect(await new MockTransport().sdlcMissingFolders(['/a', '/b'])).toEqual([]);
    });

    it('plays one stage per change, a progress after each, then done, all for the same pass id', async () => {
      const t = new MockTransport();
      const seen = await collect(t);
      const changes = await readAllChanges(t);
      const pass = await t.sdlcReadStages('/m', 'commerce');
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(seen.every((e) => e.pass === pass)).toBe(true);
      expect(seen.filter((e) => e.kind === 'stage').map((e) => (e.kind === 'stage' ? e.change : ''))).toEqual(changes.map((c) => c.change));
      expect(seen.filter((e) => e.kind === 'progress')).toEqual(changes.map((_c, i) => ({ kind: 'progress', pass, read: i + 1, total: changes.length })));
      expect(seen.at(-1)).toEqual({ kind: 'done', pass });
      expect(seen.filter((e) => e.kind === 'done')).toHaveLength(1);
    });

    it('reads the change named first before the others', async () => {
      const t = new MockTransport();
      const seen = await collect(t);
      const changes = await readAllChanges(t);
      const last = changes[changes.length - 1].change;
      await t.sdlcReadStages('/m', 'commerce', last);
      vi.advanceTimersByTime(2000);
      const stages = seen.filter((e) => e.kind === 'stage');
      expect(stages[0].kind === 'stage' && stages[0].change).toBe(last);
    });

    it('a second pass supersedes the first, whose events stop', async () => {
      const t = new MockTransport();
      const seen = await collect(t);
      const first = await t.sdlcReadStages('/m', 'commerce');
      vi.advanceTimersByTime(100);
      const second = await t.sdlcReadStages('/m', 'commerce');
      expect(second).not.toBe(first);
      const before = seen.filter((e) => e.pass === first).length;
      vi.advanceTimersByTime(2000);
      expect(seen.filter((e) => e.pass === first)).toHaveLength(before);
      expect(seen.filter((e) => e.pass === second).at(-1)).toEqual({ kind: 'done', pass: second });
    });

    it('stops reporting to a listener that left', async () => {
      const t = new MockTransport();
      const seen: StageEvent[] = [];
      const off = await t.onStageEvent((e) => seen.push(e));
      off();
      await t.sdlcReadStages('/m', 'commerce');
      vi.advanceTimersByTime(2000);
      expect(seen).toEqual([]);
    });

    it('the long demo has one change whose plan cannot be read, shown with its reason', async () => {
      window.history.replaceState({}, '', '/?demo=build-long');
      try {
        const t = new MockTransport();
        const seen = await collect(t);
        await t.sdlcReadStages('/m', 'commerce');
        vi.advanceTimersByTime(2000);
        const unreadable = seen.flatMap((e) => (e.kind === 'stage' && e.info.plan_unreadable ? [e.info] : []));
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0].plan_unreadable_reason).toBeTruthy();
      } finally {
        window.history.replaceState({}, '', '/');
      }
    });
  });
});

describe('MockTransport branch naming demos', () => {
  const REPOS = [{ repo: 'commerce-core', path: 'D:/Work/acme-commerce/commerce-core', base: 'main' }];
  /** Run `body` with `?demo=<demo>` in the address, the way the browser checks reach a demo. */
  const withDemo = async (demo: string | null, body: (t: MockTransport) => Promise<void>) => {
    window.history.replaceState({}, '', demo === null ? '/' : `/?demo=${demo}`);
    try {
      await body(new MockTransport());
    } finally {
      window.history.replaceState({}, '', '/');
    }
  };
  const publish = (t: MockTransport) => t.sdlcPublish('/w', 'acme-commerce', 'commerce-docs', 'commerce', MOCK_DONE_CHANGE, REPOS);

  it('keeps the default fixtures: no pending change, no clash, the finished change has its pull requests', async () => {
    await withDemo(null, async (t) => {
      const b = await t.sdlcBranches('/m');
      expect(b.current).toBe('main');
      expect(b.pending_change).toBeNull();
      expect(await t.sdlcRemoteClashes(REPOS, 'commerce-docs', 'commerce', MOCK_DONE_CHANGE)).toEqual([]);
      expect((await t.sdlcPullRequests('commerce-docs', 'commerce', REPOS, MOCK_DONE_CHANGE))[0].url).not.toBeNull();
      expect((await publish(t)).results[0].outcome.kind).toBe('opened');
    });
  });

  it('?demo=naming stands the master on a pending branch that holds the build demo change', async () => {
    await withDemo('naming', async (t) => {
      const b = await t.sdlcBranches('/m');
      expect(b.current?.startsWith('change/pending-')).toBe(true);
      expect(b.pending_change).toBe(`commerce/${MOCK_BUILD_CHANGE}`);
    });
  });

  it('?demo=clash leaves the finished change undeclared and reports its branch as taken in a repository', async () => {
    await withDemo('clash', async (t) => {
      expect((await t.sdlcPullRequests('commerce-docs', 'commerce', REPOS, MOCK_DONE_CHANGE))[0].url).toBeNull();
      const clashes = await t.sdlcRemoteClashes(REPOS, 'commerce-docs', 'commerce', MOCK_DONE_CHANGE);
      expect(clashes).toEqual([{ repo: 'commerce-core', branch: `change/${MOCK_DONE_CHANGE}` }]);
    });
  });

  it('the clash demos have nothing uncommitted, so declaring done gets past its first check', async () => {
    for (const demo of [null, 'clash', 'clash-push']) {
      await withDemo(demo, async (t) => {
        const left = (await t.sdlcDiffFiles('/w', 'uncommitted')).files.length;
        expect(left > 0).toBe(demo === null);
      });
    }
  });

  it('?demo=clash-push finds the branch free, then the push meets another change on it', async () => {
    await withDemo('clash-push', async (t) => {
      expect(await t.sdlcRemoteClashes(REPOS, 'commerce-docs', 'commerce', MOCK_DONE_CHANGE)).toEqual([]);
      expect((await publish(t)).results).toEqual([{ repo: 'commerce-core', outcome: { kind: 'clash', branch: `change/${MOCK_DONE_CHANGE}` } }]);
    });
  });
});

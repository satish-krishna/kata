import { MockTransport } from './mock-transport';
import { readAllChanges } from '../../../testing/read-all';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';
import { stageName, transcriptRunId } from '../../lib/sdlc';
import type { RunSpec } from '@bindings/RunSpec';
import type { DoneStep } from '@bindings/DoneStep';
import type { Resolved } from '@bindings/Resolved';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { SnapshotTarget } from '@bindings/SnapshotTarget';
import { MOCK_BUILD_CHANGE, MOCK_COPY_CHANGE, MOCK_BUILD_SECOND, MOCK_HELD_CHANGE, MOCK_DONE_CHANGE, MOCK_SETUP_FOLDER, MOCK_WORKSPACE_FOLDER, MOCK_MASTER, MOCK_STARTED_FIX, TRIAGE_LIGHT, sdlcSetupScript, sdlcSpecScript, sdlcTriageScript } from '../../lib/sdlc-mock';

const ref = (change: string): ChangeRef => ({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change });
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
    expect(await t.sdlcBranches('/m')).toEqual({ current: 'change/2026-10-17-product-notes', others: [], default_base: 'main' });
    await t.sdlcCheckout('/m', 'main');
    expect((await t.sdlcBranches('/m')).others.map((o) => o.change)).toEqual(['2026-10-17-product-notes']);
  });

  it('starting a change adds it, named from the title, on its own branch', async () => {
    const t = new MockTransport();
    const name = await t.sdlcChangeName('Password reset');
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-password-reset$/);
    const out = await t.sdlcStartChange('/ws', 'commerce', 'Password reset', 'feat', '');
    expect(out).toMatchObject({ outcome: 'started', change: name, branch: 'change/' + name });
    expect((await readAllChanges(t))[0].state.change).toBe(name);
    expect((await t.sdlcBranches('/m')).current).toBe('main');
  });

  it('a branch name the mock plugin refuses starts nothing and says why', async () => {
    const t = new MockTransport();
    const before = (await readAllChanges(t)).length;
    expect(await t.sdlcStartChange('/ws', 'commerce', 'Password reset', 'feat', '', 'main')).toMatchObject({ outcome: 'refused', kind: 'branchTaken' });
    expect(await t.sdlcStartChange('/ws', 'commerce', 'Password reset', 'feat', '', 'bad name')).toMatchObject({ outcome: 'refused', kind: 'branchInvalid' });
    expect((await readAllChanges(t)).length).toBe(before);
  });

  it('rejecting a change takes it out of the list and says where its record stays', async () => {
    const t = new MockTransport();
    const ref = { workspace: '/ws', system: 'commerce', change: '2026-10-16-price-flag' };
    expect(await t.sdlcReject(ref)).toEqual({ outcome: 'rejected', recordBranch: 'change/2026-10-16-price-flag' });
    expect((await readAllChanges(t)).find((x) => x.state.change === '2026-10-16-price-flag')).toBeUndefined();
  });


  it('the finished change has its own copy: the mock offers its removal, and removing it takes the copy away', async () => {
    const t = new MockTransport();
    const ref = { workspace: '/ws', system: 'commerce', change: MOCK_DONE_CHANGE };
    expect((await t.sdlcChangeState('/ws', 'commerce', MOCK_DONE_CHANGE)).state.inCopy).toBe(true);
    expect(await t.sdlcCopyBranch(ref)).toBe(`change/${MOCK_DONE_CHANGE}`);
    expect(await t.sdlcCopyRemoval(ref)).toEqual({ outcome: 'offer' });
    await expect(t.sdlcOpenCopyFolder(ref)).resolves.toBeUndefined();
    const out = await t.sdlcRemoveCopy(ref);
    expect(out.outcome).toBe('removed');
    expect((await t.sdlcChangeState('/ws', 'commerce', MOCK_DONE_CHANGE)).state.inCopy).toBe(false);
    expect(await t.sdlcCopyRemoval(ref)).toEqual({ outcome: 'notOffered' });
  });

  it('a change with no copy has nothing to remove or open', async () => {
    const t = new MockTransport();
    const ref = { workspace: '/ws', system: 'commerce', change: '2026-10-16-price-flag' };
    expect((await t.sdlcChangeState('/ws', 'commerce', ref.change)).state.inCopy).toBe(false);
    expect(await t.sdlcCopyRemoval(ref)).toEqual({ outcome: 'notOffered' });
    await expect(t.sdlcOpenCopyFolder(ref)).rejects.toThrow(/not in a copy/);
  });

  it('accepting the photos spec moves its change to plan-ready', async () => {
    const t = new MockTransport();
    const before = (await readAllChanges(t)).find((c) => c.state.change === '2026-10-12-product-photo-upload');
    expect(before && stageName(before.offer.stage)).toBe('spec-awaiting');
    const out = await t.sdlcAccept({ workspace: '/ws', system: 'commerce', change: '2026-10-12-product-photo-upload' }, 'spec');
    expect(out).toEqual({ outcome: 'accepted', warnings: [] });
    const after = (await readAllChanges(t)).find((c) => c.state.change === '2026-10-12-product-photo-upload');
    expect(after && stageName(after.offer.stage)).toBe('plan-ready');
  });

  it('shows a change done once the plugin has recorded the pull request of the master, links at once and states after a refresh', async () => {
    const t = new MockTransport();
    const args = [MOCK_WORKSPACE_FOLDER, 'w1', 'commerce', MOCK_BUILD_CHANGE] as const;
    const before = await t.sdlcPullRequestsView(...args, false);
    expect(before).toMatchObject({ done: false, links: [], source: null, declareOffered: true });
    const declared = await t.sdlcDeclareDone({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: MOCK_BUILD_CHANGE });
    const after = await t.sdlcPullRequestsView(...args, false);
    expect(after.done).toBe(true);
    expect(after.links.map((l) => l.repo).sort()).toEqual((declared.kind === 'done' ? declared.pullRequests.map((p) => p.repo) : []).sort());
    expect(after.links.every((l) => l.state === null && !l.lastSeen)).toBe(true);
    const refreshed = await t.sdlcPullRequestsView(...args, true);
    expect(refreshed.links.map((l) => l.url)).toEqual(after.links.map((l) => l.url));
    expect(refreshed.links.every((l) => l.state === 'open')).toBe(true);
  });

  describe('the scripted build host', () => {
    const ref = (change: string): ChangeRef => ({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change });
    const FORM = { timeoutSecs: 600 };

    it('two scripted builds run at once and both report state', async () => {
      const t = new MockTransport();
      const announced: BuildEvent[] = [];
      await t.onBuildState((e) => announced.push(e));
      expect((await t.sdlcBuildStart(ref(MOCK_BUILD_CHANGE), FORM)).kind).toBe('started');
      expect((await t.sdlcBuildStart(ref(MOCK_BUILD_SECOND), FORM)).kind).toBe('started');
      expect((await t.sdlcBuildState(ref(MOCK_BUILD_CHANGE)))?.phase).toBe('building');
      expect((await t.sdlcBuildState(ref(MOCK_BUILD_SECOND)))?.phase).toBe('building');
      expect(new Set(announced.map((e) => e.change.change))).toEqual(new Set([MOCK_BUILD_CHANGE, MOCK_BUILD_SECOND]));
      vi.advanceTimersByTime(30000);
      // The second build ends on its own; the first waits on its question.
      expect((await t.sdlcBuildState(ref(MOCK_BUILD_SECOND)))?.phase).toBe('finished');
      expect((await t.sdlcBuildState(ref(MOCK_BUILD_CHANGE)))?.phase).toBe('building');
      expect(await t.sdlcBuildState(ref('2026-01-01-never-started'))).toBeNull();
    });

    it('a build that needs a repository another change holds starts held, and says who holds it', async () => {
      const t = new MockTransport();
      await t.sdlcBuildStart(ref(MOCK_BUILD_CHANGE), FORM);
      const out = await t.sdlcBuildStart(ref(MOCK_HELD_CHANGE), FORM);
      expect(out.kind).toBe('held');
      if (out.kind === 'held') expect(out.held.map((h) => [h.repo, h.holder.change])).toEqual([['commerce-core', MOCK_BUILD_CHANGE]]);
      expect(await t.sdlcBuildState(ref(MOCK_HELD_CHANGE))).toBeNull();
    });

    it('a review that waits for a held repository names the holder, and the wait is readable later', async () => {
      const t = new MockTransport();
      await t.sdlcBuildStart(ref(MOCK_BUILD_CHANGE), FORM);
      const out = await t.sdlcReviewStart(ref(MOCK_HELD_CHANGE));
      expect(out.kind).toBe('held');
      expect((await t.sdlcReviewWaiting(ref(MOCK_HELD_CHANGE))).map((h) => h.holder.change)).toEqual([MOCK_BUILD_CHANGE]);
      expect(await t.sdlcReviewWaiting(ref(MOCK_BUILD_SECOND))).toEqual([]);
    });

    it('the running changes show the question of the build that waits on one', async () => {
      const t = new MockTransport();
      await t.sdlcBuildStart(ref(MOCK_BUILD_CHANGE), FORM);
      await t.sdlcBuildStart(ref(MOCK_BUILD_SECOND), FORM);
      vi.advanceTimersByTime(30000);
      const strip = await t.sdlcRunning();
      const first = strip.all.find((e) => e.change.change === MOCK_BUILD_CHANGE);
      expect(first?.state).toBe('needsAnswer');
      expect(strip.all.find((e) => e.change.change === MOCK_BUILD_SECOND)?.state).toBe('finished');
      expect(strip.shown.length).toBeLessThanOrEqual(3);
    });

    it('keeps the whole history of a run for a session opened late', async () => {
      const t = new MockTransport();
      await t.onRunEvent(() => undefined);
      const id = await t.runSpec(seedSpec());
      vi.advanceTimersByTime(30000);
      const history = await t.sdlcRunHistory(id);
      expect(history.length).toBeGreaterThan(2);
      expect(history[0].event.type).toBe(runScriptHead[0].ev.type);
      expect(history.map((h) => h.seq)).toEqual(history.map((_, i) => i));
      expect(await t.sdlcRunHistory('no-such-run')).toEqual([]);
    });

    it('launches a document run of a change as a scripted run with an id', async () => {
      const t = new MockTransport();
      const seen: [string, KataEvent][] = [];
      await t.onRunEvent((id, e) => seen.push([id, e]));
      const id = await t.sdlcRunChange(ref(MOCK_BUILD_CHANGE), 'spec', { name: 'sdlc-spec', task: 'x', permissionMode: 'auto', timeoutSecs: 600 });
      vi.advanceTimersByTime(30000);
      expect(seen.some(([i]) => i === id)).toBe(true);
    });
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
      const status = () => t.sdlcBuildStatus(ref(MOCK_BUILD_CHANGE));
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
      const c = (await readAllChanges(new MockTransport())).find((x) => x.state.change === MOCK_BUILD_CHANGE);
      expect(c && stageName(c.offer.stage)).toBe('build-ready');
      const repos = Object.values(c?.state.tasks ?? {});
      expect(repos).toHaveLength(2);
      expect(repos.flatMap((r) => r?.all ?? [])).toHaveLength(3);
      expect(repos.flatMap((r) => r?.logged ?? [])).toEqual([]);
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
      const target: SnapshotTarget = { kind: 'workspace', master: '/m' };
      expect((await t.sdlcLeftovers(target, { head: null, folder: '', dirty: {} })).discardable).toEqual([]);
      const id = await t.runSpec(sdlcSpec('sdlc-commerce-x-spec'));
      await t.cancelRun(id);
      const left = await t.sdlcLeftovers(target, { head: null, folder: '', dirty: {} });
      expect(left.discardable.length).toBe(2);
      expect(left.touched_dirty.length).toBe(1);
      await t.sdlcDiscard(target, { head: null, folder: '', dirty: {} }, left.discardable);
      expect((await t.sdlcLeftovers(target, { head: null, folder: '', dirty: {} })).discardable).toEqual([]);
    });

    it('reads documents by stem and rejects a file name, like the backend contract', async () => {
      const t = new MockTransport();
      expect(await t.sdlcReadDoc(ref('2026-10-12-product-photo-upload'), 'spec')).toContain('# Spec: photo upload');
      await expect(t.sdlcReadDoc(ref('2026-10-12-product-photo-upload'), 'spec.md')).rejects.toThrow(/stem/);
    });

    it('reads a change in its own copy as the copy holds it, and the same change reference through every read', async () => {
      const t = new MockTransport();
      const r = ref(MOCK_COPY_CHANGE);
      expect(await t.sdlcReadDoc(r, 'spec')).toContain('copy holds this spec');
      expect((await t.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', MOCK_COPY_CHANGE)).state.inCopy).toBe(true);
      const opened = await t.sdlcOpenChange(r, 'spec');
      expect(opened.view.state.change).toBe(MOCK_COPY_CHANGE);
      expect(opened.text).toContain('copy holds this spec');
      expect(opened.parsed?.kind).toBe('spec');
    });

    it('reads a document and its parsed read together, as the copy holds them', async () => {
      const t = new MockTransport();
      const r = ref(MOCK_COPY_CHANGE);
      const read = await t.sdlcReadDocument(r, 'spec');
      expect(read.text).toContain('copy holds this spec');
      expect(read.parsed?.kind).toBe('spec');
      const intent = await t.sdlcReadDocument(r, 'intent');
      expect(intent.text).toContain('The copy holds this intent.');
      expect(intent.parsed).toBeNull();
    });

    it('reads a change in the checkout from the checkout, with the master the checkout path', async () => {
      const t = new MockTransport();
      const r = ref('2026-10-12-product-photo-upload');
      const opened = await t.sdlcOpenChange(r, 'spec');
      expect(opened.view.state.master).toBe(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`);
      expect(opened.text).toBe(await t.sdlcReadDoc(r, 'spec'));
      expect(opened.status).toBeNull();
    });

    it('opens a planned change with its build status', async () => {
      const t = new MockTransport();
      const opened = await t.sdlcOpenChange(ref(MOCK_BUILD_CHANGE), 'plan');
      expect(opened.status).toEqual(await t.sdlcBuildStatus(ref(MOCK_BUILD_CHANGE)));
    });

    it('opens a planned change whose build status cannot be read: no status and a notice, never a failed open (F1)', async () => {
      const t = new MockTransport();
      vi.spyOn(t, 'sdlcBuildStatus').mockRejectedValue(new Error('path does not exist in HEAD'));
      const opened = await t.sdlcOpenChange(ref(MOCK_BUILD_CHANGE), 'plan');
      expect(opened.status).toBeNull();
      expect(opened.view.state.change).toBe(MOCK_BUILD_CHANGE);
      expect(opened.notices).toEqual(['path does not exist in HEAD']);
    });

    it('opens a planned change whose review cannot be read: no review and a notice, not a swallowed empty value (F1)', async () => {
      const t = new MockTransport();
      vi.spyOn(t, 'sdlcReviewRecord').mockRejectedValue(new Error('review is unreadable'));
      const opened = await t.sdlcOpenChange(ref(MOCK_BUILD_CHANGE), 'plan');
      expect(opened.review).toBeNull();
      expect(opened.notices).toEqual(['review is unreadable']);
    });

    it('opens a change with no notices when every read succeeds', async () => {
      const t = new MockTransport();
      expect((await t.sdlcOpenChange(ref(MOCK_BUILD_CHANGE), 'plan')).notices).toEqual([]);
    });

    it('rejects every read of a change it does not list, with the message for a removed copy', async () => {
      const t = new MockTransport();
      const gone = ref('2026-01-01-no-such-change');
      const message = "This change's copy was removed and the plugin no longer lists it.";
      await expect(t.sdlcReadDoc(gone, 'spec')).rejects.toThrow(message);
      await expect(t.sdlcOpenChange(gone, 'spec')).rejects.toThrow(message);
      await expect(t.sdlcBuildStatus(gone)).rejects.toThrow(message);
      await expect(t.sdlcChangeRepos(gone)).rejects.toThrow(message);
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

  describe('reading the changes', () => {
    it('reads one change in full, and refuses a change it does not have', async () => {
      const t = new MockTransport();
      const [first] = await readAllChanges(t);
      const view = await t.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', first.state.change);
      expect(view).toEqual(first);
      await expect(t.sdlcChangeState(MOCK_WORKSPACE_FOLDER, 'commerce', 'no-such-change')).rejects.toThrow();
    });

    it('reports no folder missing', async () => {
      expect(await new MockTransport().sdlcMissingFolders(['/a', '/b'])).toEqual([]);
    });

    it('the long demo has one change whose plan cannot be read, shown with its reason', async () => {
      window.history.replaceState({}, '', '/?demo=build-long');
      try {
        const t = new MockTransport();
        const [system] = (await t.sdlcState(MOCK_WORKSPACE_FOLDER, ['commerce'])).systems;
        const unreadable = system.changes.filter((c) => c.offer.stage === 'plan-unreadable');
        expect(unreadable).toHaveLength(1);
        expect(system.problems.length).toBeGreaterThan(0);
      } finally {
        window.history.replaceState({}, '', '/');
      }
    });
  });
});

describe('MockTransport branch naming demos', () => {
  /** Run `body` with `?demo=<demo>` in the address, the way the browser checks reach a demo. */
  const withDemo = async (demo: string | null, body: (t: MockTransport) => Promise<void>) => {
    window.history.replaceState({}, '', demo === null ? '/' : `/?demo=${demo}`);
    try {
      await body(new MockTransport());
    } finally {
      window.history.replaceState({}, '', '/');
    }
  };

  it('keeps the default fixtures: the master on main, the finished change has its pull requests', async () => {
    await withDemo(null, async (t) => {
      const b = await t.sdlcBranches('/m');
      expect(b.current).toBe('main');
      expect((await t.sdlcPullRequestsView(MOCK_WORKSPACE_FOLDER, 'w1', 'commerce', MOCK_DONE_CHANGE, false)).links[0].url).toContain('github.com');
    });
  });


});

describe('MockTransport declaring-done demos', () => {
  const ref: ChangeRef = { workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change: MOCK_DONE_CHANGE };
  /** Run `body` with `?demo=<demo>` in the address, the way the browser checks reach a demo. */
  const withDemo = async (demo: string | null, body: (t: MockTransport) => Promise<void>) => {
    window.history.replaceState({}, '', demo === null ? '/' : `/?demo=${demo}`);
    try {
      await body(new MockTransport());
    } finally {
      window.history.replaceState({}, '', '/');
    }
  };

  it('declares done with every pull request, the master last, naming each step it is on (R7.1 passes, R7.3)', async () => {
    await withDemo(null, async (t) => {
      const steps: DoneStep[] = [];
      await t.onDoneStep((step) => steps.push(step));
      const view = await t.sdlcDeclareDone(ref);
      expect(view.kind).toBe('done');
      const repos = view.kind === 'done' ? view.pullRequests.map((p) => p.repo) : [];
      expect(repos.at(-1)).toBe('commerce-docs');
      expect(steps.map((s) => s.label)).toEqual([
        'Declaring done: the plugin is verifying the change',
        ...repos.flatMap((r) => [`Pushing ${r}`, `Opening a pull request in ${r}`]),
      ]);
    });
  });

  it.each([
    ['done-refused', 'notReady'],
    ['done-gh', 'notReady'],
    ['done-cannot', 'couldNotRun'],
  ] as const)("?demo=%s gives the plugin's %s answer (R7.1, R9.1)", async (demo, kind) => {
    await withDemo(demo, async (t) => {
      const view = await t.sdlcDeclareDone(ref);
      expect(view.kind).toBe(kind);
      if (view.kind === 'notReady' && demo === 'done-gh') expect(view.problems).toEqual(["Declaring done needs GitHub's command-line tool, gh. Install it from https://cli.github.com and reopen."]);
      if (view.kind === 'notReady' && demo === 'done-refused') expect(view.problems.join(' ')).toContain('has unresolved high findings');
    });
  });

  it("?demo=done-warnings declares done with the plugin's warnings (F22)", async () => {
    await withDemo('done-warnings', async (t) => {
      const view = await t.sdlcDeclareDone(ref);
      expect(view.kind === 'done' ? view.warnings : null).toEqual(['after hook announce failed with exit code 1; nothing was undone']);
    });
  });

  it('?demo=done-partial stops part way, and declaring done again carries on to done (R7.1 fails)', async () => {
    await withDemo('done-partial', async (t) => {
      const first = await t.sdlcDeclareDone(ref);
      expect(first.kind).toBe('partial');
      expect((await t.sdlcDeclareDone(ref)).kind).toBe('done');
    });
  });

  it('the done demos have nothing uncommitted, so declaring done is offered at once', async () => {
    for (const demo of [null, 'done-refused']) {
      await withDemo(demo, async (t) => {
        expect((await t.sdlcDiffFiles('/w', 'uncommitted')).files.length > 0).toBe(demo === null);
      });
    }
  });
});

describe('MockTransport answers every call the backend gained on this branch (F29)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const ref = (change: string): ChangeRef => ({ workspace: MOCK_WORKSPACE_FOLDER, system: 'commerce', change });
  const FORM = { timeoutSecs: 600 };
  const FORM_RUN = { name: 'sdlc-spec', task: 'x', permissionMode: 'prompt' as const, timeoutSecs: 900 };

  it("sdlcTriageChange names the change the triage's own run started through the plugin, and none for any other run", async () => {
    const t = new MockTransport();
    await t.onRunEvent(() => undefined);
    const id = await t.runSpec({ ...seedSpec(), name: 'sdlc-commerce-new-triage' });
    vi.advanceTimersByTime(total(sdlcTriageScript.head));
    await t.submitAnswer(id, 'q1', [[TRIAGE_LIGHT]]);
    vi.advanceTimersByTime(total(sdlcTriageScript.mid));
    const transcript = 'sdlc-commerce-new-triage-20261024T090000Z';
    expect(await t.sdlcTriageChange(transcript, 'commerce')).toBe(MOCK_STARTED_FIX);
    expect(await t.sdlcTriageChange(transcript, 'other')).toBeNull();
    expect(await t.sdlcTriageChange('sdlc-commerce-spec-1', 'commerce')).toBeNull();
  });

  it('sdlcBuildBoard places each repository: working, stopped, finished, not started and idle, with its tasks', async () => {
    const t = new MockTransport();
    const status = {
      tasks: [{ id: 'T1', repo: 'a', row: null }, { id: 'T2', repo: 'b', row: null }],
      repos: [{ repo: 'a', state: { kind: 'ready', task: 'T1' } }, { repo: 'b', state: { kind: 'ready', task: 'T2' } }, { repo: 'c', state: { kind: 'done' } }, { repo: 'd', state: { kind: 'ready', task: 'T4' } }],
      departures: [], hasTasks: true, problems: [], logLayouts: [],
    } as unknown as Parameters<MockTransport['sdlcBuildBoard']>[1];
    const board = await t.sdlcBuildBoard(['a', 'b', 'c', 'd', 'e'], status, ['a'], { b: { task: 'T2', reason: 'cancelled' } as never });
    expect(board.map((r) => [r.repo, r.situation.kind])).toEqual([['a', 'working'], ['b', 'stopped'], ['c', 'finished'], ['d', 'not-started'], ['e', 'idle']]);
    expect(board[0].tasks).toEqual([{ id: 'T1', state: { kind: 'running' } }]);
  });

  it("sdlcReviewStanding reads the review document first: none, current and stale; without one, the latest review run's", async () => {
    const t = new MockTransport();
    const scope = { workspaceId: 'w', system: 'commerce', change: 'c' };
    const doc = (commits: Record<string, string>) => ({ reviews: [{ commits }], master_moved: [], problems: [] }) as never;
    const base = { links: [], records: [], heads: { app: 'abc1234' }, scope, master: MOCK_MASTER };
    expect(await t.sdlcReviewStanding({ ...base, document: { reviews: [], master_moved: [], problems: [] } as never })).toEqual({ kind: 'none' });
    expect(await t.sdlcReviewStanding({ ...base, document: doc({ app: 'abc1' }) })).toEqual({ kind: 'current-document', review: 0 });
    expect(await t.sdlcReviewStanding({ ...base, document: doc({ app: 'fff1' }) })).toEqual({ kind: 'stale' });
    const link = { workspace_id: 'w', system: 'commerce', change: 'c', stage: 'review', run_id: 'r1', started_at: 1, heads: { app: 'abc1234' } };
    expect(await t.sdlcReviewStanding({ ...base, document: null, links: [link], records: [{ id: 'r1', exit: 0 }] as never })).toEqual({ kind: 'current-run', runId: 'r1' });
    expect(await t.sdlcReviewStanding({ ...base, document: null, links: [link], records: [{ id: 'r1', exit: 1 }] as never })).toEqual({ kind: 'unfinished' });
  });

  it('sdlcChangeKey normalizes the workspace folder the way the backend keys it', async () => {
    const key = await new MockTransport().sdlcChangeKey({ workspace: 'D:\\WS\\Acme\\', system: 'commerce', change: 'c' });
    expect(key).toEqual({ workspace: { key: 'd:/ws/acme', name: 'acme' }, system: 'commerce', change: 'c' });
  });

  it('sdlcBuildRuns lists the live runs of a build, sdlcBuildCancel stops one, and sdlcBuildContinue starts it again', async () => {
    const t = new MockTransport();
    await t.onRunEvent(() => undefined);
    expect(await t.sdlcBuildRuns(ref(MOCK_BUILD_SECOND))).toEqual([]);
    await t.sdlcBuildStart(ref(MOCK_BUILD_SECOND), FORM);
    const runs = await t.sdlcBuildRuns(ref(MOCK_BUILD_SECOND));
    expect(runs.length).toBeGreaterThan(0);
    const repo = runs[0].key;
    expect(runs.every((r) => r.run !== '')).toBe(true);
    expect((await t.sdlcBuildContinue(ref(MOCK_BUILD_SECOND), repo)).kind).toBe('alreadyRunning');
    await t.sdlcBuildCancel(ref(MOCK_BUILD_SECOND), repo);
    vi.advanceTimersByTime(1000);
    expect((await t.sdlcBuildRuns(ref(MOCK_BUILD_SECOND))).some((r) => r.key === repo)).toBe(false);
    expect((await t.sdlcBuildContinue(ref(MOCK_BUILD_SECOND), repo)).kind).not.toBe('alreadyRunning');
  });

  it("sdlcPreviewChangeRun composes the run from the form: a document run keeps the form's permission mode, a triage or fix run is auto", async () => {
    const t = new MockTransport();
    const spec = await t.sdlcPreviewChangeRun(ref(MOCK_BUILD_CHANGE), 'spec', FORM_RUN);
    expect([spec.name, spec.task, spec.permissions.mode, spec.leash.timeout_secs]).toEqual(['sdlc-spec', 'x', 'prompt', 900]);
    expect(spec.given?.required_plugins).toEqual(['ai-sdlc']);
    expect((await t.sdlcPreviewChangeRun(ref(MOCK_BUILD_CHANGE), 'fix', FORM_RUN)).permissions.mode).toBe('auto');
    expect((await t.sdlcPreviewChangeRun(ref(MOCK_BUILD_CHANGE), 'triage', FORM_RUN)).permissions.mode).toBe('auto');
  });

  it('sdlcPreviewBuild gives one section per repository then the review, and one section for one repository', async () => {
    const t = new MockTransport();
    const all = await t.sdlcPreviewBuild(ref(MOCK_BUILD_CHANGE), 'start', null, FORM);
    expect(all.at(-1)?.title).toBe('Review');
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((s) => s.spec.leash.timeout_secs === 600)).toBe(true);
    const one = await t.sdlcPreviewBuild(ref(MOCK_BUILD_CHANGE), 'continue-one', 'commerce-core', FORM);
    expect(one.map((s) => s.repo)).toEqual(['commerce-core']);
    expect((await t.sdlcPreviewBuild(ref(MOCK_BUILD_CHANGE), 'manual-review', null, FORM)).map((s) => s.title)).toEqual(['Review']);
  });

  it("sdlcReviewView, sdlcRoundOffer and sdlcRoundPlan read the same review: the offer's default picks plan a round", async () => {
    const t = new MockTransport();
    const view = await t.sdlcReviewView(ref(MOCK_BUILD_CHANGE));
    const [offer, picks] = await t.sdlcRoundOffer(ref(MOCK_BUILD_CHANGE));
    const keys = offer.findings.map((f) => f.key);
    expect(view.groups.flatMap((g) => g.findings.map((f) => f.key)).sort()).toEqual([...keys].sort());
    expect(picks.picked.every((k) => keys.includes(k))).toBe(true);
    const plan = await t.sdlcRoundPlan(ref(MOCK_BUILD_CHANGE), { picked: [], assigned: {}, notes: {} });
    expect(plan).toEqual({ blocked: 'Pick a finding or write a note.', requests: [] });
  });

  it('sdlcMarkOpened and sdlcCloseAnswer have nothing to do in the browser and resolve', async () => {
    const t = new MockTransport();
    await expect(t.sdlcMarkOpened(ref(MOCK_BUILD_CHANGE))).resolves.toBeUndefined();
    await expect(t.sdlcCloseAnswer(true)).resolves.toBeUndefined();
  });

  it('sdlcRenameBranch renames the change branch in every repository that has it', async () => {
    const out = await new MockTransport().sdlcRenameBranch(MOCK_WORKSPACE_FOLDER, 'w1', 'commerce', MOCK_BUILD_CHANGE, 'feat/x');
    expect(out).toMatchObject({ outcome: 'renamed', from: `change/${MOCK_BUILD_CHANGE}`, to: 'feat/x' });
  });

  it("sdlcChecksView gives each repository's checks with the plugin's sentence", async () => {
    const views = await new MockTransport().sdlcChecksView(ref(MOCK_DONE_CHANGE));
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v.summary !== '')).toBe(true);
  });

  it('sdlcOldChecks says nothing without ?demo=old-checks, and sdlcOldChecksSeen resolves', async () => {
    const t = new MockTransport();
    expect(await t.sdlcOldChecks(MOCK_WORKSPACE_FOLDER, ['commerce'])).toEqual([]);
    await expect(t.sdlcOldChecksSeen(['commerce'])).resolves.toBeUndefined();
  });

  it('onRunning hands every new strip to its listener until unlistened', async () => {
    const t = new MockTransport();
    const seen: unknown[] = [];
    const off = await t.onRunning((s) => seen.push(s));
    await t.sdlcBuildStart(ref(MOCK_BUILD_SECOND), FORM);
    expect(seen.length).toBeGreaterThan(0);
    off();
    const before = seen.length;
    await t.sdlcBuildStart(ref(MOCK_BUILD_CHANGE), FORM);
    expect(seen.length).toBe(before);
  });

  it('onCloseAsked asks nothing outside ?demo=close', async () => {
    const t = new MockTransport();
    const seen: unknown[] = [];
    const off = await t.onCloseAsked((a) => seen.push(a));
    await Promise.resolve();
    expect(seen).toEqual([]);
    off();
  });
});

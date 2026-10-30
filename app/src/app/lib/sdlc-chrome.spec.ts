import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { Stage } from '@bindings/Stage';
import { parseFrontMatter, stagePills, stageRuns, type StagePill } from './sdlc';

describe('parseFrontMatter', () => {
  // The three real Part 2 documents' front matter, copied.
  const INTENT = [
    '---',
    'title: Build the plan, review what changed, open pull requests',
    'system: kata',
    'author: SatishKrishna Pilla, Maintainer',
    'date: 2026-10-19',
    'status: accepted',
    'scope: sdlc',
    'context: [kata@7226252]',
    '---',
    '',
    '# Intent: Build the plan, review what changed, open pull requests',
    '',
  ].join('\n');

  it('reads each key: value line as a field, in order, with the value as written', () => {
    const got = parseFrontMatter(INTENT);
    expect(got.fields).toEqual([
      ['title', 'Build the plan, review what changed, open pull requests'],
      ['system', 'kata'],
      ['author', 'SatishKrishna Pilla, Maintainer'],
      ['date', '2026-10-19'],
      ['status', 'accepted'],
      ['scope', 'sdlc'],
      ['context', '[kata@7226252]'],
    ]);
    expect(got.body).toBe('\n# Intent: Build the plan, review what changed, open pull requests\n');
  });

  it('keeps a value that has colons in it whole, and a list as written', () => {
    const got = parseFrontMatter('---\nsource_intent: 2026-10-19-ai-sdlc-part-2/intent.md\npolicies_applied: [house-style]\nnote: a: b\n---\nbody\n');
    expect(got.fields).toEqual([
      ['source_intent', '2026-10-19-ai-sdlc-part-2/intent.md'],
      ['policies_applied', '[house-style]'],
      ['note', 'a: b'],
    ]);
    expect(got.body).toBe('body\n');
  });

  it('gives no fields and the whole text when there is no front matter, or it never closes', () => {
    expect(parseFrontMatter('# Title\n')).toEqual({ fields: [], body: '# Title\n' });
    expect(parseFrontMatter('---\nstatus: draft\n# never closed')).toEqual({ fields: [], body: '---\nstatus: draft\n# never closed' });
  });

  it('reads Windows line endings', () => {
    expect(parseFrontMatter('---\r\nstatus: draft\r\ndate: 2026-10-19\r\n---\r\n# T\r\n')).toEqual({
      fields: [['status', 'draft'], ['date', '2026-10-19']],
      body: '# T\r\n',
    });
  });
});

describe('stageRuns', () => {
  const link = (stage: string, run_id: string, started_at: number, change = 'c1', system = 'commerce', workspace_id = 'ws'): RunLink =>
    ({ workspace_id, system, change, stage, run_id, started_at });
  const rec = (id: string, kata: string, started_at: number): RunRecord => ({ id, kata, started_at, isolation: 'none', steered: false });

  it('lists the stage’s linked runs and its unlinked history records, newest first', () => {
    const links = [link('spec', 'r1', 5), link('spec', 'r3', 9), link('plan', 'p1', 20)];
    const records = [rec('r1', 'sdlc-commerce-c1-spec', 5), rec('r2', 'sdlc-commerce-c1-spec', 7), rec('r3', 'sdlc-commerce-c1-spec', 9), rec('p1', 'sdlc-commerce-c1-plan', 20)];
    expect(stageRuns(links, records, 'ws', 'commerce', 'c1', 'spec').map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('names a link whose record is missing by the stage’s deterministic run name', () => {
    const got = stageRuns([link('intent', 'gone', 4)], [], 'ws', 'commerce', 'c1', 'intent');
    expect(got).toEqual([{ id: 'gone', kata: 'sdlc-commerce-c1-intent', started_at: 4, isolation: 'none', steered: false }]);
  });

  it('leaves out other changes, systems and workspaces', () => {
    const links = [link('spec', 'a', 1), link('spec', 'b', 2, 'other'), link('spec', 'c', 3, 'c1', 'billing'), link('spec', 'd', 4, 'c1', 'commerce', 'ws2')];
    const records = [rec('e', 'sdlc-commerce-other-spec', 5), rec('f', 'sdlc-billing-c1-spec', 6)];
    expect(stageRuns(links, records, 'ws', 'commerce', 'c1', 'spec').map((r) => r.id)).toEqual(['a']);
  });

  it('counts every build:<repo> link and every build record as build, and keeps review apart', () => {
    const links = [link('build:app', 'b1', 1), link('build:api', 'b2', 3), link('review', 'v1', 6)];
    const records = [rec('b3', 'sdlc-commerce-c1-build-web', 4), rec('v1', 'sdlc-commerce-c1-review', 6), rec('v2', 'sdlc-commerce-c1-review', 8)];
    expect(stageRuns(links, records, 'ws', 'commerce', 'c1', 'build').map((r) => r.id)).toEqual(['b3', 'b2', 'b1']);
    expect(stageRuns(links, records, 'ws', 'commerce', 'c1', 'review').map((r) => r.id)).toEqual(['v2', 'v1']);
  });

  it('lists a run once even when two links name it', () => {
    const links = [link('spec', 'r1', 5), link('spec', 'r1', 5)];
    expect(stageRuns(links, [rec('r1', 'sdlc-commerce-c1-spec', 5)], 'ws', 'commerce', 'c1', 'spec')).toHaveLength(1);
  });
});

describe('stagePills', () => {
  const ALL_DOCS = { intent: true, spec: true, plan: true };

  /** One pill, every field written out. */
  const pill = (step: StagePill['step'], title: string, text: string, tone: StagePill['tone'], disabled: boolean, current: boolean, ariaLabel: string | null): StagePill =>
    ({ step, title, text, tone, disabled, current, ariaLabel });

  // The four pills of each row, written out by hand from the decision table: before the current step a pill reads
  // "<Title>" (success, labeled "<Title>, accepted"); at it, the stage label; after it, "<Title> · not started".
  // Build reads "Build · locked" and is disabled until the plan is accepted.
  const LOCKED = pill('build', 'Build', 'Build · locked', 'idle', true, false, null);
  const ROWS: [Stage, boolean, StagePill[]][] = [
    ['intent-in-progress', false, [
      pill('intent', 'Intent', 'Intent · in progress (not committed)', 'idle', false, true, null),
      pill('spec', 'Spec', 'Spec · not started', 'idle', false, false, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['intent-awaiting', false, [
      pill('intent', 'Intent', 'Intent · awaiting acceptance', 'warning', false, true, null),
      pill('spec', 'Spec', 'Spec · not started', 'idle', false, false, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['intent-accepted-uncommitted', false, [
      pill('intent', 'Intent', 'Intent · accepted, not committed', 'warning', false, true, null),
      pill('spec', 'Spec', 'Spec · not started', 'idle', false, false, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['rejected', false, [
      pill('intent', 'Intent', 'Closed · rejected', 'error', false, true, null),
      pill('spec', 'Spec', 'Spec · not started', 'idle', false, false, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['spec-ready', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec · ready to start', 'idle', false, true, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['spec-awaiting', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec · awaiting acceptance', 'warning', false, true, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['spec-accepted-uncommitted', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec · accepted, not committed', 'warning', false, true, null),
      pill('plan', 'Plan', 'Plan · not started', 'idle', false, false, null),
      LOCKED,
    ]],
    ['plan-ready', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan · ready to start', 'idle', false, true, null),
      LOCKED,
    ]],
    ['plan-awaiting', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan · awaiting acceptance', 'warning', false, true, null),
      LOCKED,
    ]],
    ['plan-accepted-uncommitted', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan · accepted, not committed', 'warning', false, true, null),
      LOCKED,
    ]],
    ['plan-out-of-date', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan · out of date', 'warning', false, true, null),
      LOCKED,
    ]],
    ['plan-superseded', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan · superseded', 'warning', false, true, null),
      LOCKED,
    ]],
    ['build-ready', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan', 'success', false, false, 'Plan, accepted'),
      pill('build', 'Build', 'Build · ready to start', 'idle', false, true, null),
    ]],
    ['build-stopped', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan', 'success', false, false, 'Plan, accepted'),
      pill('build', 'Build', 'Build · in progress (stopped)', 'warning', false, true, null),
    ]],
    ['build-finished', false, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan', 'success', false, false, 'Plan, accepted'),
      pill('build', 'Build', 'Build · finished, not yet done', 'success', false, true, null),
    ]],
    // Done replaces the stage's own label: the build pill reads "Build · done" whatever stage the files say.
    ['build-finished', true, [
      pill('intent', 'Intent', 'Intent', 'success', false, false, 'Intent, accepted'),
      pill('spec', 'Spec', 'Spec', 'success', false, false, 'Spec, accepted'),
      pill('plan', 'Plan', 'Plan', 'success', false, false, 'Plan, accepted'),
      pill('build', 'Build', 'Build · done', 'success', false, true, null),
    ]],
  ];

  it.each(ROWS)('%s (done: %s) gives the four pills the table lists', (stage, done, expected) => {
    expect(stagePills(stage, done, ALL_DOCS)).toEqual(expected);
  });

  it('marks exactly one pill current in every row', () => {
    for (const [stage, done] of ROWS) {
      expect(stagePills(stage, done, ALL_DOCS).filter((p) => p.current)).toHaveLength(1);
    }
  });

  it('disables a document pill whose document does not exist, whatever its position', () => {
    // spec-awaiting: intent before, spec at, plan after. Only the intent document exists.
    const got = stagePills('spec-awaiting', false, { intent: true, spec: false, plan: false });
    expect(got.map((p) => [p.step, p.disabled])).toEqual([['intent', false], ['spec', true], ['plan', true], ['build', true]]);
    // plan-awaiting: the earlier documents are missing but the plan pill itself is there.
    const earlier = stagePills('plan-awaiting', false, { intent: false, spec: false, plan: true });
    expect(earlier.map((p) => [p.step, p.disabled])).toEqual([['intent', true], ['spec', true], ['plan', false], ['build', true]]);
  });

  it('enables the build pill of an accepted plan, whether or not any repository has the change’s branch', () => {
    expect(stagePills('build-ready', false, ALL_DOCS)[3]).toEqual(pill('build', 'Build', 'Build · ready to start', 'idle', false, true, null));
    expect(stagePills('build-finished', true, ALL_DOCS)[3]).toEqual(pill('build', 'Build', 'Build · done', 'success', false, true, null));
  });

  it('keeps the build pill locked and disabled before the plan is accepted', () => {
    expect(stagePills('plan-accepted-uncommitted', false, ALL_DOCS)[3]).toEqual(LOCKED);
  });
});

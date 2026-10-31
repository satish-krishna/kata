import type { Finding } from './sdlc';
import { defaultPicks, roundOffer, roundPlan, type RoundPicks } from './build-round';

const f = (id: string, severity: Finding['severity'], repo: string | undefined, over: Partial<Finding> = {}): Finding => ({
  id,
  severity,
  repo,
  text: `Text of ${id}.`,
  ...over,
});

const review = {
  number: 2,
  findings: [
    f('F1', 'high', 'catalog-api', { file: 'src/Upload.cs', line: 12, concern: 'bug', text: 'Upload ignores the size limit.\nIt accepts 20 MB.' }),
    f('F2', 'medium', 'catalog-api', { file: 'src/List.cs', line: 40, text: 'Listing is not paged.' }),
    f('F3', 'medium', 'catalog-api', { file: 'src/Price.cs', concern: 'convention', text: 'Price uses a float.' }),
    f('F4', 'low', 'catalog-api', { file: 'src/Name.cs', line: 3, text: 'Name is misspelled.' }),
    f('F5', 'high', 'storefront-web', { file: 'web/cart.ts', line: 7, concern: 'spec', text: 'Cart loses items on reload.' }),
    f('F6', 'medium', 'storefront-web', { file: 'web/page.ts', line: 9, text: 'Page title is empty.' }),
    f('F7', 'low', 'storefront-web', { file: 'web/css.ts', line: 1, text: 'Color is off by one shade.' }),
    f('F8', 'medium', undefined, { text: 'Logging is missing.' }),
  ],
};
const repos = ['ai-sdlc', 'catalog-api', 'storefront-web'];
const offer = () => roundOffer(review, repos);
const picks = (keys: string[], extra: Partial<RoundPicks> = {}): RoundPicks => ({
  picked: new Set(keys),
  assigned: {},
  notes: {},
  ...extra,
});

describe('build round', () => {
  it('lists no findings without a review (R5.6)', () => {
    const o = roundOffer(null, repos);
    expect(o.findings).toEqual([]);
    expect(o.review).toBeNull();
    expect(o.repos).toEqual(repos);
  });

  it('keys a finding without an id by its place in the list', () => {
    const o = roundOffer({ number: null, findings: [{ severity: 'low', text: 'a' }, { severity: 'high', text: 'b', id: 'X' }] }, repos);
    expect(o.findings.map((x) => x.key)).toEqual(['#1', 'X']);
    expect(o.findings[0].repo).toBeNull();
  });

  it('picks high and medium by default (R5.1)', () => {
    expect([...defaultPicks(offer()).picked].sort()).toEqual(['F1', 'F2', 'F3', 'F5', 'F6', 'F8']);
  });

  it('picks critical and leaves a finding without severity unpicked', () => {
    const o = roundOffer({ number: 1, findings: [{ severity: 'critical', text: 'a', id: 'C' }, { severity: null, text: 'b', id: 'N' }] }, repos);
    expect([...defaultPicks(o).picked]).toEqual(['C']);
  });

  it('sends the changed picks to the repository (R5.2)', () => {
    const plan = roundPlan(offer(), picks(['F1', 'F3', 'F4']));
    expect(plan.blocked).toBeNull();
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0].repo).toBe('catalog-api');
    expect(plan.requests[0].instructions).toBe(
      [
        'Fix these findings from review 2 of this change in this repository.',
        '- F1 (high, bug) src/Upload.cs:12',
        '  Upload ignores the size limit.',
        '  It accepts 20 MB.',
        '- F3 (medium, convention) src/Price.cs',
        '  Price uses a float.',
        '- F4 (low) src/Name.cs:3',
        '  Name is misspelled.',
      ].join('\n'),
    );
  });

  it('blocks on a picked finding with no repository until one is chosen (R5.3)', () => {
    const blocked = roundPlan(offer(), picks(['F1', 'F8']));
    expect(blocked.blocked).toBe('Choose a repository for F8.');
    expect(blocked.requests).toEqual([]);
    const ok = roundPlan(offer(), picks(['F1', 'F8'], { assigned: { F8: 'storefront-web' } }));
    expect(ok.blocked).toBeNull();
    expect(ok.requests.map((r) => r.repo)).toEqual(['catalog-api', 'storefront-web']);
    expect(ok.requests[1].instructions).toBe(
      ['Fix these findings from review 2 of this change in this repository.', '- F8 (medium)', '  Logging is missing.'].join('\n'),
    );
  });

  it('names every picked finding without a repository, in list order', () => {
    const o = roundOffer(
      { number: 1, findings: [{ severity: 'high', text: 'a', id: 'F8' }, { severity: 'high', text: 'b', id: 'F9' }] },
      repos,
    );
    expect(roundPlan(o, picks(['F9', 'F8'])).blocked).toBe('Choose a repository for F8, F9.');
  });

  it('says exactly which agents start and what each fixes (R5.4)', () => {
    const plan = roundPlan(offer(), picks(['F1', 'F3', 'F5', 'F6']));
    expect(plan.requests.map((r) => r.summary)).toEqual(['catalog-api · F1, F3', 'storefront-web · F5, F6']);
  });

  it('cannot start with nothing picked and no note (R5.5)', () => {
    const plan = roundPlan(offer(), picks([], { notes: { 'catalog-api': '   ' } }));
    expect(plan.blocked).toBe('Pick a finding or write a note.');
    expect(plan.requests).toEqual([]);
  });

  it('starts an agent for a note alone (R6.1)', () => {
    const plan = roundPlan(offer(), picks([], { notes: { 'storefront-web': '  Rename the upload button to Add photos  ' } }));
    expect(plan.blocked).toBeNull();
    expect(plan.requests).toEqual([
      {
        repo: 'storefront-web',
        instructions: 'Also from the engineer:\nRename the upload button to Add photos',
        summary: 'storefront-web · with a note',
      },
    ]);
  });

  it('puts the note after the findings (R6.2)', () => {
    const plan = roundPlan(offer(), picks(['F1'], { notes: { 'catalog-api': 'Keep the 8 MB limit' } }));
    expect(plan.requests[0].instructions).toBe(
      [
        'Fix these findings from review 2 of this change in this repository.',
        '- F1 (high, bug) src/Upload.cs:12',
        '  Upload ignores the size limit.',
        '  It accepts 20 MB.',
        '',
        'Also from the engineer:',
        'Keep the 8 MB limit',
      ].join('\n'),
    );
    expect(plan.requests[0].summary).toBe('catalog-api · F1 · with a note');
  });

  it('names the latest review when the offer has no number', () => {
    const o = roundOffer({ number: null, findings: [{ severity: 'high', text: 'Broken.', id: 'F1', repo: 'catalog-api' }] }, repos);
    expect(roundPlan(o, picks(['F1'])).requests[0].instructions).toBe(
      ['Fix these findings from the latest review of this change in this repository.', '- F1 (high)', '  Broken.'].join('\n'),
    );
  });

  it('keeps the master repository first in offer order (R5.7)', () => {
    const o = roundOffer({ number: 1, findings: [{ severity: 'high', text: 'x', id: 'F1', repo: 'ai-sdlc' }] }, repos);
    expect(roundPlan(o, picks(['F1'], { notes: { 'catalog-api': 'n' } })).requests.map((r) => r.repo)).toEqual(['ai-sdlc', 'catalog-api']);
  });

  it('tells a repository nothing about other repositories findings (R7.2)', () => {
    const text = roundPlan(offer(), picks(['F1', 'F3', 'F5'])).requests[0].instructions;
    expect(text).toContain('Upload ignores the size limit.\n  It accepts 20 MB.');
    expect(text).toContain('Price uses a float.');
    expect(text).not.toContain('F5');
    expect(text).not.toContain('Cart loses items on reload.');
  });

  it('leaves an unpicked finding out of every request (R9.1)', () => {
    const plan = roundPlan(offer(), picks(['F1', 'F5'], { notes: { 'catalog-api': 'n' } }));
    expect(plan.blocked).toBeNull();
    const catalog = plan.requests.find((r) => r.repo === 'catalog-api');
    const storefront = plan.requests.find((r) => r.repo === 'storefront-web');
    expect(catalog).toBeDefined();
    expect(storefront).toBeDefined();
    expect(catalog!.instructions).toContain('- F1 (high, bug) src/Upload.cs:12');
    expect(storefront!.instructions).toContain('- F5 (high, spec) web/cart.ts:7');
    const all = plan.requests.map((r) => r.instructions).join('\n');
    expect(all).not.toContain('F4');
    expect(all).not.toContain('Name is misspelled.');
    const summaries = plan.requests.map((r) => r.summary).join('\n');
    expect(summaries).toBe('catalog-api · F1 · with a note\nstorefront-web · F5');
    expect(summaries).not.toContain('F4');
  });
});

describe('build round: a finding naming a repository outside the build (F9)', () => {
  const outside: Finding = { id: 'F9', severity: 'high', repo: 'legacy-api', text: 'Legacy call is unchecked.' };
  const o = () => roundOffer({ number: 3, findings: [outside] }, ['ai-sdlc', 'catalog-api']);

  it('is offered with no repository, like a finding that names none, and picked by default', () => {
    expect(o().findings.map((x) => x.repo)).toEqual([null]);
    expect([...defaultPicks(o()).picked]).toEqual(['F9']);
  });

  it('blocks the round until a repository is chosen', () => {
    const plan = roundPlan(o(), picks(['F9']));
    expect(plan.blocked).toBe('Choose a repository for F9.');
    expect(plan.requests).toEqual([]);
  });

  it('is sent to the repository chosen for it', () => {
    const plan = roundPlan(o(), picks(['F9'], { assigned: { F9: 'catalog-api' } }));
    expect(plan.blocked).toBeNull();
    expect(plan.requests).toEqual([
      {
        repo: 'catalog-api',
        instructions: 'Fix these findings from review 3 of this change in this repository.\n- F9 (high)\n  Legacy call is unchecked.',
        summary: 'catalog-api · F9',
      },
    ]);
  });
});

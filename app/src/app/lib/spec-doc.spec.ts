import { PART2_SPEC } from '../../testing/fixtures/part2-spec';
import { requirements, splitStep } from './spec-doc';

// The start of the real Part 2 spec's gherkin block: R1.1 is a plain scenario, R1.4 and R1.5 are outlines.
const EXCERPT = [
  '---',
  'status: accepted',
  '---',
  '',
  '## Requirements',
  '',
  '```gherkin',
  'Feature: Build the plan, review what changed, open pull requests',
  '  A change goes from an accepted plan to open pull requests.',
  '',
  '  Background:',
  '    Given a workspace with a master repository and the product repositories of the system',
  '    And the engineer is signed in to GitHub on this machine',
  '',
  '  Rule: R1 — The engineer accepts a written plan, and only an accepted plan can be built (from: Proposed outcome 1, D13)',
  '',
  '    Scenario: R1.1 — A written plan waits for acceptance',
  '      Given a change whose plan has been written but not accepted',
  '      When the engineer opens the change',
  '      Then the change shows "Plan · awaiting acceptance"',
  '      And the engineer cannot start a build',
  '',
  '    Scenario Outline: R1.4 — A plan or spec written from an older version of the document above it cannot be built',
  '      Given a change whose plan is accepted',
  '      And <document> was written from a version of <upstream> that is not the one accepted now',
  '      When the engineer opens the change',
  '      Then the engineer cannot start a build',
  '      And the engineer is told to <action>',
  '',
  '      Examples:',
  '        | document  | upstream   | action                                  |',
  '        | the plan  | the spec   | rewrite the plan                        |',
  '        | the spec  | the intent | rewrite the spec, then rewrite the plan |',
  '',
  '  Rule: R2 — The engineer starts a build with a time limit (from: Proposed outcome 1–2, D5, open question 2)',
  '',
  '    Scenario: R2.1 — The build asks for a time limit',
  '      Given a change whose plan is accepted',
  '      Then the engineer sees the limit',
  '```',
  '',
  '## Out of scope',
  '',
  '- Scenario: this prose is outside the block and is not read.',
  '',
].join('\n');

describe('requirements', () => {
  it('reads each Rule as a requirement with its id, title and sources', () => {
    const got = requirements(EXCERPT);
    expect(got.map((r) => ({ id: r.id, title: r.title, from: r.from, scenarios: r.scenarios.map((s) => s.id) }))).toEqual([
      { id: 'R1', title: 'The engineer accepts a written plan, and only an accepted plan can be built', from: 'Proposed outcome 1, D13', scenarios: ['R1.1', 'R1.4'] },
      { id: 'R2', title: 'The engineer starts a build with a time limit', from: 'Proposed outcome 1–2, D5, open question 2', scenarios: ['R2.1'] },
    ]);
  });

  it('reads a plain scenario: its title, its steps with their keywords, no examples', () => {
    expect(requirements(EXCERPT)[0].scenarios[0]).toEqual({
      id: 'R1.1',
      title: 'A written plan waits for acceptance',
      outline: false,
      steps: [
        'Given a change whose plan has been written but not accepted',
        'When the engineer opens the change',
        'Then the change shows "Plan · awaiting acceptance"',
        'And the engineer cannot start a build',
      ],
      examples: null,
    });
  });

  it('reads a Scenario Outline with its examples table, header row first', () => {
    expect(requirements(EXCERPT)[0].scenarios[1]).toEqual({
      id: 'R1.4',
      title: 'A plan or spec written from an older version of the document above it cannot be built',
      outline: true,
      steps: [
        'Given a change whose plan is accepted',
        'And <document> was written from a version of <upstream> that is not the one accepted now',
        'When the engineer opens the change',
        'Then the engineer cannot start a build',
        'And the engineer is told to <action>',
      ],
      examples: [
        ['document', 'upstream', 'action'],
        ['the plan', 'the spec', 'rewrite the plan'],
        ['the spec', 'the intent', 'rewrite the spec, then rewrite the plan'],
      ],
    });
  });

  it('does not read the Background as a scenario', () => {
    expect(requirements(EXCERPT).flatMap((r) => r.scenarios).map((s) => s.id)).toEqual(['R1.1', 'R1.4', 'R2.1']);
  });

  it('is empty for a document with no gherkin block', () => {
    expect(requirements('## Requirements\n\nProse only.\n')).toEqual([]);
    expect(requirements('')).toEqual([]);
  });

  it('is empty when the rules parse but none has a scenario, so no requirement shows 0 scenarios', () => {
    const rulesOnly = ['```gherkin', 'Feature: Demo', '', '  Rule: R1 — First (from: D1)', '', '    Scenario: one without an id', '      Given a thing', '', '  Rule: R2 — Second (from: D2)', '```'].join('\n');
    expect(requirements(rulesOnly)).toEqual([]);
  });

  it('keeps a rule that has no scenario next to one that has', () => {
    const mixed = ['```gherkin', 'Feature: Demo', '  Rule: R1 — First (from: D1)', '  Rule: R2 — Second (from: D2)', '    Scenario: R2.1 — Only one', '      Given a thing', '```'].join('\n');
    expect(requirements(mixed).map((r) => [r.id, r.scenarios.length])).toEqual([['R1', 0], ['R2', 1]]);
  });

  it('reads Windows line endings', () => {
    expect(requirements(EXCERPT.replace(/\n/g, '\r\n'))[0].scenarios[1].examples).toEqual([
      ['document', 'upstream', 'action'],
      ['the plan', 'the spec', 'rewrite the plan'],
      ['the spec', 'the intent', 'rewrite the spec, then rewrite the plan'],
    ]);
  });

  it('reads the whole real Part 2 spec: 20 requirements and the scenario count of each', () => {
    const got = requirements(PART2_SPEC);
    expect(got.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `R${i + 1}`));
    expect(got.map((r) => r.scenarios.length)).toEqual([5, 5, 2, 3, 2, 7, 8, 4, 2, 1, 7, 1, 4, 2, 1, 3, 7, 3, 6, 3]);
    // Every scenario carries the id of its requirement as a prefix, and every title and step is non-empty.
    for (const r of got) {
      expect(r.title).not.toBe('');
      expect(r.from).not.toBe('');
      for (const s of r.scenarios) {
        expect(s.id.startsWith(`${r.id}.`)).toBe(true);
        expect(s.title).not.toBe('');
        expect(s.steps.length).toBeGreaterThan(0);
      }
    }
    // R20.3 is the last scenario of the spec, an outline with three examples under its header.
    const last = got[19].scenarios[2];
    expect(last.id).toBe('R20.3');
    expect(last.outline).toBe(true);
    expect(last.examples).toHaveLength(4);
    expect(last.examples![0]).toEqual(['situation', 'what']);
  });
});

describe('splitStep', () => {
  it('splits a step into its keyword and the rest', () => {
    expect(splitStep('Given a claim with 10 photos')).toEqual(['Given', 'a claim with 10 photos']);
    expect(splitStep('And it stays')).toEqual(['And', 'it stays']);
  });
});

import { outline, section } from './doc';

// An excerpt of the real Part 2 spec: heading levels, parentheses, a fence that holds "#" lines.
const SPEC = [
  '---',
  'status: accepted',
  '---',
  '',
  '# Spec: Build the plan, review what changed, open pull requests',
  '',
  '## Requirements',
  '',
  '```gherkin',
  '# a comment inside a fence is not a heading',
  '## nor is this',
  'Feature: Build the plan',
  '```',
  '',
  '## Out of scope',
  '',
  '- D7: following pull requests after they open.',
  '',
  '## Design',
  '',
  '### Shape in one paragraph',
  '',
  'The build stage adds plan acceptance.',
  '',
  '### Plan acceptance (R1, R15)',
  '',
  'Accept the plan.',
  '',
  '#### The driver',
  '',
  'Text.',
  '',
  '## Areas of concern',
  '',
  'Last.',
  '',
].join('\n');

describe('outline', () => {
  it('lists every heading outside a fence with its level, plain text and slug', () => {
    expect(outline(SPEC)).toEqual([
      { level: 1, text: 'Spec: Build the plan, review what changed, open pull requests', id: 'spec-build-the-plan-review-what-changed-open-pull-requests' },
      { level: 2, text: 'Requirements', id: 'requirements' },
      { level: 2, text: 'Out of scope', id: 'out-of-scope' },
      { level: 2, text: 'Design', id: 'design' },
      { level: 3, text: 'Shape in one paragraph', id: 'shape-in-one-paragraph' },
      { level: 3, text: 'Plan acceptance (R1, R15)', id: 'plan-acceptance-r1-r15' },
      { level: 4, text: 'The driver', id: 'the-driver' },
      { level: 2, text: 'Areas of concern', id: 'areas-of-concern' },
    ]);
  });

  it('reads the text of a heading with inline code and emphasis, not its markup', () => {
    const got = outline('### The `Depends on` line of **each** task\n');
    expect(got).toEqual([{ level: 3, text: 'The Depends on line of each task', id: 'the-depends-on-line-of-each-task' }]);
  });

  it('numbers a repeated heading the way GitHub does', () => {
    const got = outline('## Approach\n\n## Notes\n\n## Approach\n\n## Approach\n');
    expect(got.map((h) => h.id)).toEqual(['approach', 'notes', 'approach-1', 'approach-2']);
  });

  it('is empty for a document with no headings', () => {
    expect(outline('Just text.\n')).toEqual([]);
    expect(outline('')).toEqual([]);
  });
});

describe('section', () => {
  it('returns the heading line through the line before the next ## heading', () => {
    expect(section(SPEC, 'Design')).toBe(
      [
        '## Design',
        '',
        '### Shape in one paragraph',
        '',
        'The build stage adds plan acceptance.',
        '',
        '### Plan acceptance (R1, R15)',
        '',
        'Accept the plan.',
        '',
        '#### The driver',
        '',
        'Text.',
      ].join('\n'),
    );
  });

  it('runs to the end of the document for the last section', () => {
    expect(section(SPEC, 'Areas of concern')).toBe('## Areas of concern\n\nLast.');
  });

  it('does not end a section at a ## line inside a fence', () => {
    expect(section(SPEC, 'Requirements')).toBe(
      ['## Requirements', '', '```gherkin', '# a comment inside a fence is not a heading', '## nor is this', 'Feature: Build the plan', '```'].join('\n'),
    );
  });

  it('is null when the heading is absent, and does not match a deeper heading of the same name', () => {
    expect(section(SPEC, 'Approach')).toBeNull();
    expect(section(SPEC, 'The driver')).toBeNull();
  });

  it('reads Windows line endings', () => {
    expect(section('## A\r\n\r\ntext\r\n\r\n## B\r\n', 'A')).toBe('## A\n\ntext');
  });
});

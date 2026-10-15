import { describe, it, expect } from 'vitest';

// Strips `//` line comments before scanning for quoted entries. Without this,
// an odd single-quote character (an apostrophe) in a comment inside the array
// silently corrupts every entry parsed after it - this already happened once
// during this branch's development.
const stripLineComments = (block) => block.replace(/\/\/[^\n]*/g, '');

const parseQuotedEntries = (block) => [...stripLineComments(block).matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

describe('the array-body parser is not fooled by an apostrophe in a comment', () => {
  it('parses entries correctly even when a comment line contains a single quote', () => {
    const body = `
  'zero-entry',
  // a comment mentioning the editor's own habits, with an apostrophe
  'real-entry-one',
  'real-entry-two',
`;
    expect(parseQuotedEntries(body)).toEqual(['real-entry-one', 'real-entry-two', 'zero-entry'].sort());
  });

  it('would have swallowed an entry if comments were not stripped first (proves the bug this guards against)', () => {
    const body = `
  'zero-entry',
  // a comment mentioning the editor's own habits, with an apostrophe
  'real-entry-one',
  'real-entry-two',
`;
    const withoutStripping = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(withoutStripping).not.toEqual(['real-entry-one', 'real-entry-two', 'zero-entry'].sort());
  });
});
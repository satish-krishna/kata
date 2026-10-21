import { describe, it, expect } from 'vitest';
import { nextChangeLine, previousChangeLine } from './change-navigation';

const changes = [
  { modifiedStartLineNumber: 5, modifiedEndLineNumber: 7 },
  { modifiedStartLineNumber: 20, modifiedEndLineNumber: 0 },
  { modifiedStartLineNumber: 40, modifiedEndLineNumber: 41 },
];

describe('change navigation', () => {
  it('next moves to the first change below the cursor and wraps to the top', () => {
    expect(nextChangeLine(changes, 1)).toBe(5);
    expect(nextChangeLine(changes, 5)).toBe(20);
    expect(nextChangeLine(changes, 40)).toBe(5);
  });

  it('previous moves to the last change above the cursor and wraps to the bottom', () => {
    expect(previousChangeLine(changes, 30)).toBe(20);
    expect(previousChangeLine(changes, 5)).toBe(40);
  });

  it('a deletion at the top of the file anchors on line 1', () => {
    expect(nextChangeLine([{ modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 }], 0)).toBe(1);
  });

  it('there is nowhere to go without changes', () => {
    expect(nextChangeLine([], 1)).toBeNull();
    expect(previousChangeLine([], 1)).toBeNull();
  });
});

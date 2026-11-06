import { describe, it, expect } from 'vitest';
import { parseOptions } from '../../parity/options.mjs';

const names = ['sdlc-home', 'library'];

describe('parseOptions', () => {
  it('refuses --update without --only', () => {
    expect(() => parseOptions(['--update'], names)).toThrow(/--update needs --only/);
    const o = parseOptions(['--update', '--only', 'sdlc-home'], names);
    expect(o.update).toBe(true);
    expect([...o.only]).toEqual(['sdlc-home']);
  });
});

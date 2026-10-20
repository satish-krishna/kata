import { prNumber } from './pull-request';

describe('prNumber', () => {
  it('reads the number of a pull request address', () => {
    expect(prNumber('https://github.com/acme/claims-core/pull/42')).toBe('42');
    expect(prNumber('https://github.com/acme/claims-core/pull/42/')).toBe('42');
  });
  it('is null for any other address', () => {
    expect(prNumber('https://github.com/acme/claims-core')).toBeNull();
  });
});

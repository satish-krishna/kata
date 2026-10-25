import { locateFinding, type RepoPaths } from './finding-place';

const portal: RepoPaths = {
  repo: 'customer-portal',
  whole: ['src/a.ts', 'src/b.ts'],
  committed: ['src/a.ts'],
  uncommitted: ['src/b.ts'],
};
const core: RepoPaths = { repo: 'claims-core', whole: ['src/c.cs', 'src/a.ts'], committed: ['src/c.cs', 'src/a.ts'], uncommitted: [] };

describe('locateFinding', () => {
  // The precedence rows.
  it('row 1: a finding naming nothing has no file', () => {
    expect(locateFinding({}, [portal], 'whole')).toEqual({ kind: 'no-file' });
  });

  it('row 1: a line without a file names nothing', () => {
    expect(locateFinding({ line: 12 }, [portal], 'whole')).toEqual({ kind: 'no-file' });
  });

  it('row 2: a file no repository has is not in the change', () => {
    expect(locateFinding({ file: 'src/none.ts', line: 3 }, [portal, core], 'whole')).toEqual({ kind: 'not-in-change' });
  });

  it('row 3: a file in more than one repository asks which', () => {
    expect(locateFinding({ file: 'src/a.ts', line: 7 }, [portal, core], 'whole')).toEqual({
      kind: 'choose',
      repos: ['customer-portal', 'claims-core'],
      path: 'src/a.ts',
      line: 7,
    });
  });

  it('row 4: a file the part on show does not list switches to the whole change', () => {
    expect(locateFinding({ file: 'src/b.ts', line: 4 }, [portal], 'committed')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/b.ts',
      line: 4,
      switchToWhole: true,
    });
  });

  it('row 5: a file the part on show lists is shown as it is', () => {
    expect(locateFinding({ file: 'src/a.ts', line: 4 }, [portal], 'committed')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/a.ts',
      line: 4,
      switchToWhole: false,
    });
  });

  it('with the whole change on show, row 4 cannot match', () => {
    expect(locateFinding({ file: 'src/b.ts', line: 4 }, [portal], 'whole')).toMatchObject({ kind: 'show', switchToWhole: false });
  });

  // The R4.1 rows.
  it('R4.1 row 1: the whole change, a file and a line, among the changed files', () => {
    expect(locateFinding({ file: 'src/b.ts', line: 9 }, [portal], 'whole')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/b.ts',
      line: 9,
      switchToWhole: false,
    });
  });

  it('R4.1 row 2: only committed work, a file and a line, among the committed changes', () => {
    expect(locateFinding({ file: 'src/a.ts', line: 9 }, [portal], 'committed')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/a.ts',
      line: 9,
      switchToWhole: false,
    });
  });

  it('R4.1 row 3: only committed work, only among the uncommitted changes', () => {
    expect(locateFinding({ file: 'src/b.ts', line: 9 }, [portal], 'committed')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/b.ts',
      line: 9,
      switchToWhole: true,
    });
  });

  it('R4.1 row 4: only uncommitted work, only among the committed changes', () => {
    expect(locateFinding({ file: 'src/a.ts', line: 9 }, [portal], 'uncommitted')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/a.ts',
      line: 9,
      switchToWhole: true,
    });
  });

  it('R4.1 row 5: a file but no line shows from its top', () => {
    expect(locateFinding({ file: 'src/b.ts' }, [portal], 'whole')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/b.ts',
      line: null,
      switchToWhole: false,
    });
  });

  it('R4.1 row 6: a file not changed by this change', () => {
    expect(locateFinding({ file: 'src/z.ts', line: 1 }, [portal], 'whole')).toEqual({ kind: 'not-in-change' });
  });

  it('R4.1 row 7: a file changed in more than one repository', () => {
    expect(locateFinding({ file: 'src/a.ts', line: 2 }, [portal, core], 'whole')).toEqual({
      kind: 'choose',
      repos: ['customer-portal', 'claims-core'],
      path: 'src/a.ts',
      line: 2,
    });
  });

  it('R4.1 row 8: no file', () => {
    expect(locateFinding({}, [portal, core], 'whole')).toEqual({ kind: 'no-file' });
  });

  it('looks a path led by a repository name up in that repository only, without the name', () => {
    expect(locateFinding({ file: 'customer-portal/src/a.ts', line: 5 }, [portal, core], 'whole')).toEqual({
      kind: 'show',
      repo: 'customer-portal',
      path: 'src/a.ts',
      line: 5,
      switchToWhole: false,
    });
  });

  it('does not fall back to other repositories when the named repository lacks the file', () => {
    expect(locateFinding({ file: 'customer-portal/src/c.cs', line: 5 }, [portal, core], 'whole')).toEqual({ kind: 'not-in-change' });
  });
});

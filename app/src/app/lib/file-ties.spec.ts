import type { BuildRow } from '@bindings/BuildRow';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { Part } from '@bindings/Part';
import { tieFiles } from './file-ties';

const sha = (head: string): string => head.padEnd(40, '0');
const row = (task: string, commits: string[], repo = 'api'): BuildRow => ({ task, repo, commits, departure: null });
const commit = (head: string, files: string[]): CommitFiles => ({ sha: sha(head), files });
const file = (path: string, oldPath: string | null = null): ChangedFile => ({
  path,
  oldPath,
  status: oldPath ? 'renamed' : 'modified',
  binary: false,
  added: 1,
  removed: 0,
  uncommitted: false,
});

interface Case {
  name: string;
  rows: BuildRow[];
  commits: CommitFiles[];
  files: ChangedFile[];
  part: Part;
  expected: Record<string, string[]>;
}

const cases: Case[] = [
  {
    name: 'a commit one row lists ties that task',
    rows: [row('T1', ['aaa111'])],
    commits: [commit('aaa111', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': ['T1'] },
  },
  {
    name: 'commits of two rows, one task each, tie both in plan order',
    rows: [row('T1', ['aaa111']), row('T2', ['bbb222'])],
    commits: [commit('aaa111', ['a.ts']), commit('bbb222', ['a.ts'])],
    files: [file('a.ts')],
    part: 'committed',
    expected: { 'a.ts': ['T1', 'T2'] },
  },
  {
    name: 'a commit two rows both list ties nothing',
    rows: [row('T1', ['aaa111']), row('T2', ['aaa111'])],
    commits: [commit('aaa111', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': [] },
  },
  {
    name: 'a commit no row lists ties nothing',
    rows: [row('T1', ['aaa111'])],
    commits: [commit('ccc333', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': [] },
  },
  {
    name: 'uncommitted edits tie nothing even when a listed commit touched the file',
    rows: [row('T1', ['aaa111'])],
    commits: [commit('aaa111', ['a.ts'])],
    files: [file('a.ts')],
    part: 'uncommitted',
    expected: { 'a.ts': [] },
  },
  {
    name: 'a file with no touching commit ties nothing',
    rows: [row('T1', ['aaa111'])],
    commits: [commit('aaa111', ['other.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': [] },
  },
  {
    name: 'a listed commit adds its task while an unlisted and a shared commit add nothing',
    rows: [row('T1', ['aaa111']), row('T2', ['bbb222']), row('T3', ['bbb222'])],
    commits: [commit('aaa111', ['a.ts']), commit('bbb222', ['a.ts']), commit('ccc333', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': ['T1'] },
  },
  {
    name: 'a short SHA that matches two commits ties nothing',
    rows: [row('T1', ['abc'])],
    commits: [commit('abc111', ['a.ts']), commit('abc222', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': [] },
  },
  {
    name: 'a short SHA that matches one commit ties, whatever its case',
    rows: [row('T1', ['ABC1'])],
    commits: [commit('abc111', ['a.ts']), commit('def222', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': ['T1'] },
  },
  {
    name: 'a row for another repository is ignored',
    rows: [row('T1', ['aaa111'], 'web')],
    commits: [commit('aaa111', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': [] },
  },
  {
    name: 'a renamed file is tied only by the commit under its current path',
    rows: [row('T1', ['aaa111']), row('T2', ['bbb222'])],
    commits: [commit('aaa111', ['old.ts']), commit('bbb222', ['new.ts'])],
    files: [file('new.ts', 'old.ts')],
    part: 'whole',
    expected: { 'new.ts': ['T2'] },
  },
  {
    name: 'a task listed twice for one file appears once',
    rows: [row('T1', ['aaa111', 'bbb222'])],
    commits: [commit('aaa111', ['a.ts']), commit('bbb222', ['a.ts'])],
    files: [file('a.ts')],
    part: 'whole',
    expected: { 'a.ts': ['T1'] },
  },
];

describe('tieFiles', () => {
  it('decides every row of the tie table', () => {
    for (const c of cases) {
      const got = tieFiles(c.rows, 'api', c.commits, c.files, c.part);
      expect(Object.fromEntries(got), c.name).toEqual(c.expected);
    }
  });
});

// The change record, `intent/<system>/<change>/change.yml`: the change's branch, work type, scope and base branch, written
// by `change start`, and the pull requests `change.done` opened. It is apart from intent.md because acceptance pins
// are diffs on the documents: a field of the intent that changed after acceptance would reopen it. Before 0.18.0 the
// tool driving the build kept the branch in `branch.md`, and before that the branch was always `change/<change>`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '../vendor/yaml.mjs';
import { parseFrontMatter } from '../documents/front-matter.ts';

export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];

export type PullRequest = { repo: string; url: string; number: number; pushed: string };

export type ChangeRecord = { version: 1; branch: string; type: string; scope: string; base: string; pullRequests: PullRequest[] };

export const RECORD_FILE = 'change.yml';

/** Problems with a record's content; `where` names the file in none of them, so `check` can place them. */
export function recordProblems(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['change.yml must be a YAML mapping'];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(r)) if (!['version', 'branch', 'type', 'scope', 'base', 'pullRequests'].includes(key)) problems.push(`unknown field ${key}`);
  if (r.version !== 1) problems.push('version must be 1');
  if (typeof r.branch !== 'string' || r.branch === '') problems.push('branch must be the change branch name');
  if (typeof r.type !== 'string' || !COMMIT_TYPES.includes(r.type)) problems.push(`type must be one of ${COMMIT_TYPES.join(', ')}`);
  if (typeof r.scope !== 'string' || r.scope === '') problems.push('scope must be the change\'s commit scope');
  if (typeof r.base !== 'string' || r.base === '') problems.push('base must be the base branch name');
  if (r.pullRequests !== undefined) {
    if (!Array.isArray(r.pullRequests)) problems.push('pullRequests must be a list');
    else {
      r.pullRequests.forEach((p, i) => {
        const pr = p as Record<string, unknown> | null;
        const ok = pr !== null && typeof pr === 'object' && typeof pr.repo === 'string' && typeof pr.url === 'string' && /^https?:\/\//.test(pr.url) && Number.isInteger(pr.number) && typeof pr.pushed === 'string' && /^[0-9a-f]{7,40}$/.test(pr.pushed);
        if (!ok) problems.push(`pullRequests[${i}] must have repo, url (http or https), number and pushed (a commit)`);
      });
    }
  }
  return problems;
}

export function readRecord(folder: string): ChangeRecord | null {
  const file = join(folder, RECORD_FILE);
  if (!existsSync(file)) return null;
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (recordProblems(raw).length > 0) return null;
  return { version: 1, branch: raw.branch as string, type: raw.type as string, scope: raw.scope as string, base: raw.base as string, pullRequests: (raw.pullRequests as PullRequest[] | undefined) ?? [] };
}

/** YAML for a record. Strings are written JSON-quoted, which YAML reads as the same strings. */
export function recordText(record: ChangeRecord): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    '# Written by the ai-sdlc program (change start, change rename, change.done); do not edit by hand.',
    'version: 1',
    `branch: ${q(record.branch)}`,
    `type: ${record.type}`,
    `scope: ${q(record.scope)}`,
    `base: ${q(record.base)}`,
  ];
  if (record.pullRequests.length > 0) {
    lines.push('pullRequests:');
    for (const pr of record.pullRequests) lines.push(`  - repo: ${q(pr.repo)}`, `    url: ${q(pr.url)}`, `    number: ${pr.number}`, `    pushed: ${q(pr.pushed)}`);
  }
  return lines.join('\n') + '\n';
}

export function writeRecord(folder: string, record: ChangeRecord): string {
  const file = join(folder, RECORD_FILE);
  writeFileSync(file, recordText(record));
  return file;
}

/** The change's branch: its record, else the older `branch.md`, else `change/<change>`. */
export function branchOf(folder: string): string {
  const record = readRecord(folder);
  if (record) return record.branch;
  const older = join(folder, 'branch.md');
  if (existsSync(older)) {
    try {
      const fm = parseFrontMatter(readFileSync(older, 'utf8'), older).data;
      if (typeof fm.branch === 'string' && fm.branch !== '') return fm.branch;
    } catch {
      // An unreadable branch.md names no branch.
    }
  }
  return `change/${basename(folder)}`;
}

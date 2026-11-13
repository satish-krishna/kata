// change.start: a new change gets its branch and its own copy of the master repository before anything is written.
// The branch is named by `--branch`, else by the team's naming on the base branch's marker, else `change/<change>`,
// and is created off the master's base branch. The copy is a git worktree on that branch in
// `<workspace>/.ai-sdlc/copies/<change>/`, so the engineer's own checkout stays on its branch and several changes
// can be in flight. The change's record, `change.yml`, is committed there first. Run again, it finds its work done.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COMMIT_TYPES, readRecord, writeRecord } from '../../changes/record.ts';
import { baseRevision, commitOf, commitPaths, git, hasLocalBranch, showFile } from '../../git/git.ts';
import { productRepositories } from '../../workspace/apps.ts';
import { branchClashes } from '../../workspace/branches.ts';
import { checkBranchName, checkNaming, checkScope, namingFromText, renderNaming } from '../../workspace/naming.ts';
import { copiesFolder, type EventContext } from '../context.ts';
import type { Step } from './step.ts';

const CHANGE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const copyOf = (ctx: EventContext): string => join(copiesFolder(ctx.workspace), ctx.change);

/** The branch the change gets, and why a name cannot be given. */
function branchName(ctx: EventContext): { name: string | null; problems: string[] } {
  if (ctx.extra.branch) return { name: ctx.extra.branch, problems: [] };
  const revision = ctx.base ? baseRevision(ctx.master, ctx.base) : null;
  const marker = revision ? showFile(ctx.master, revision, '.ai-sdlc.json') : null;
  const naming = marker === null ? { declared: false as const } : namingFromText(marker, ctx.system, '.ai-sdlc.json on the base branch');
  if (!naming.declared) return { name: `change/${ctx.change}`, problems: [] };
  const problems = checkNaming(naming.setting);
  if (problems.length > 0) return { name: null, problems: problems.map((p) => `the team naming on the base branch: ${p}`) };
  const values = { type: ctx.extra.type ?? '', scope: ctx.extra.scope ?? '', change: ctx.change, ...(ctx.extra.title ? { title: ctx.extra.title } : {}) };
  return { name: renderNaming(naming.setting, values).branch, problems: [] };
}

function existingCopy(ctx: EventContext): { record: ReturnType<typeof readRecord>; exists: boolean } {
  const copy = copyOf(ctx);
  return { exists: existsSync(copy), record: existsSync(copy) ? readRecord(join(copy, 'intent', ctx.system, ctx.change)) : null };
}

export const changeStart: Step = {
  reusePassed: false,
  check(ctx) {
    const problems: string[] = [];
    if (!CHANGE_NAME.test(ctx.change)) problems.push(`${ctx.change} is not a change name: YYYY-MM-DD-<slug>, lowercase letters, digits and hyphens`);
    if (!COMMIT_TYPES.includes(ctx.extra.type ?? '')) problems.push(`the work type must be one of ${COMMIT_TYPES.join(', ')}`);
    problems.push(...checkScope(ctx.extra.scope ?? '').map((p) => `the scope: ${p}`));
    if (ctx.base === null || baseRevision(ctx.master, ctx.base) === null) problems.push('the master repository has no base branch (the remote\'s default, main or master) on this machine');
    if (problems.length > 0) return problems;
    const { exists, record } = existingCopy(ctx);
    if (exists && record) return [];
    if (exists) return [`${copyOf(ctx)} exists but holds no change.yml for ${ctx.change}; move it away, or finish the change it belongs to`];
    if (existsSync(join(ctx.master, 'intent', ctx.system, ctx.change))) return [`${ctx.change} already exists in ${ctx.master}: it was started before changes had their own copy, and it keeps working where it is`];
    const { name, problems: naming } = branchName(ctx);
    if (name === null) return naming;
    const invalid = checkBranchName(name);
    if (invalid.length > 0) return invalid.map((p) => `${name}: ${p}`);
    return branchClashes(name, [{ repo: 'master', path: ctx.master }, ...productRepositories(ctx.master, ctx.workspace, ctx.repos)]);
  },
  act(ctx) {
    const copy = copyOf(ctx);
    const folder = join(copy, 'intent', ctx.system, ctx.change);
    const found = existingCopy(ctx);
    const point = (branch: string) => {
      ctx.master = copy;
      ctx.repoPath = copy;
      ctx.folder = folder;
      ctx.branch = branch;
      ctx.head = commitOf(copy, 'HEAD');
    };
    if (found.record) {
      point(found.record.branch);
      return { problems: [], details: { branch: found.record.branch, type: found.record.type, base: found.record.base, copy, created: false } };
    }
    const { name } = branchName(ctx);
    const branch = name as string;
    const base = ctx.base as string;
    if (!hasLocalBranch(ctx.master, branch)) {
      const made = git(ctx.master, ['branch', branch, baseRevision(ctx.master, base) as string]);
      if (!made.ok) return { problems: [`git could not create ${branch}: ${made.stderr.trim()}`] };
    }
    mkdirSync(copiesFolder(ctx.workspace), { recursive: true });
    const added = git(ctx.master, ['worktree', 'add', '--quiet', copy, branch]);
    if (!added.ok) return { problems: [`git could not make the change's copy in ${copy}: ${added.stderr.trim()}`] };
    mkdirSync(folder, { recursive: true });
    const file = writeRecord(folder, { version: 1, branch, type: ctx.extra.type as string, scope: ctx.extra.scope as string, base, pullRequests: [] });
    const header = `docs(${ctx.extra.scope}): start change ${ctx.change}`;
    const committed = commitPaths(copy, [file], [header, 'Generated-By: ai-sdlc']);
    if (!committed.ok) return { problems: [`the commit "${header}" failed in ${copy}: ${committed.error}`], details: { branch, copy } };
    point(branch);
    return { problems: [], details: { branch, type: ctx.extra.type, base, copy, created: true } };
  },
};

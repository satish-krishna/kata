// change.done: the change is verified, then every touched repository is pushed and gets a pull request, and the
// pull requests are recorded in change.yml. Nothing leaves the machine until every check passes:
//
//   1. every repository the plan names has a build log entry for each of its tasks, has the change's branch, and
//      has no uncommitted files, nor has the change's copy;
//   2. every commit on a touched repository's branch carries the change's scope and the ai-sdlc trailer;
//   3. the latest review covered each touched repository at its current head, and has no critical or high finding
//      (a finding is resolved when a later review no longer reports it);
//   4. build.finish (the repository's checks) passed at each touched repository's head; a stale result is run again;
//   5. each touched repository and the master have a remote, the engineer is signed in to GitHub with gh for each
//      host, and the branch on each remote is free or already holds this change's own commits.
//
// Then, product repositories first: push the branch (the repository's pre-push hooks run), and open a pull request,
// or keep the open one a retry finds. Then change.yml gets the pull requests and is committed in the copy, the copy
// is pushed, the master's pull request is opened with the others listed, and its own link is committed and pushed
// too. A failure stops at once and says what was pushed and opened; running it again carries on from there. A
// touched product repository is one whose change branch has commits beyond its base; the master is always touched.
//
// In the single-repo layout the same checks run with apps for repositories, over the one repository (the change's
// copy): an app is touched when the branch changed a file in its folder, its head is the latest commit touching its
// folder, build.finish runs only for touched apps, and the branch is pushed once with one pull request that is
// recorded as `master`. A plan app that is not touched is listed in `details.untouched`, not refused.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planRepos, unloggedTasks } from '../../changes/progress.ts';
import { branchOf, readRecord, writeRecord, type ChangeRecord, type PullRequest } from '../../changes/record.ts';
import { changeScope, commitRuleProblems } from '../../changes/scope.ts';
import { parseFrontMatter } from '../../documents/front-matter.ts';
import { readReview } from '../../documents/review.ts';
import type { ParsedReview, ParsedReviewSection } from '../../common/types.ts';
import { baseRevision, commitOf, commitPaths, commitsBeyondBase, currentBranch, dirtyPaths, git, gitOut, hasLocalBranch, isAncestor, showFile, baseBranch } from '../../git/git.ts';
import { hostOf, openNew, openPullRequest, signInProblem } from '../../git/gh.ts';
import { namingFromText, renderNaming } from '../../workspace/naming.ts';
import { appFolders, appHead, isSingleRepo, repoPathOf, touchedApps } from '../../workspace/apps.ts';
import type { EventContext } from '../context.ts';
import { runEvent } from '../runner.ts';
import type { Step } from './step.ts';

type Repo = { repo: string; path: string; head: string };

/** The product repositories the plan names whose change branch has commits beyond the base. */
function touched(ctx: EventContext, branch: string): Repo[] {
  return planRepos(ctx.folder)
    .filter((r) => r !== 'master')
    .flatMap((repo) => {
      const path = join(ctx.workspace, repo);
      const base = baseBranch(path);
      const head = commitOf(path, `refs/heads/${branch}`);
      if (base === null || head === null || commitsBeyondBase(path, `refs/heads/${branch}`, base).length === 0) return [];
      return [{ repo, path, head }];
    });
}

/** The latest review section, or null when there is none that reads. */
function latestReview(folder: string): ParsedReviewSection | null {
  const file = join(folder, 'build', 'review.md');
  if (!existsSync(file)) return null;
  const result = readReview(readFileSync(file, 'utf8'), file);
  if (result.kind !== 'review') return null;
  const reviews = (result.document as ParsedReview).reviews;
  return reviews[reviews.length - 1] ?? null;
}

/** Severities that hold a change back: a finding of one in the latest review is unresolved until a later review drops it. */
const BLOCKING: readonly string[] = ['critical', 'high'];

/** The latest review's blocking findings, each as `F<n> (<repo>, <file>:<line>): <first line of its text>`. */
function blockingFindings(review: ParsedReviewSection): string[] {
  return review.findings
    .filter((f) => BLOCKING.includes(f.severity))
    .map((f) => `${f.id} (${f.repo ? `${f.repo}, ` : ''}${f.file}:${f.line}): ${f.text.trim().split('\n')[0] ?? ''}`.trimEnd());
}

function intentTitle(folder: string): string {
  const file = join(folder, 'intent.md');
  if (!existsSync(file)) return '';
  const title = parseFrontMatter(readFileSync(file, 'utf8'), file).data.title;
  return typeof title === 'string' ? title : '';
}

/** The pull request title: the team's pattern on the base branch's marker, else the intent's title. */
function pullRequestTitle(ctx: EventContext, record: ChangeRecord): string {
  const title = intentTitle(ctx.folder) || ctx.change;
  const revision = ctx.base ? baseRevision(ctx.master, ctx.base) : null;
  const marker = revision ? showFile(ctx.master, revision, '.ai-sdlc.json') : null;
  if (marker === null) return title;
  const naming = namingFromText(marker, ctx.system, '.ai-sdlc.json on the base branch');
  if (!naming.declared || !naming.setting.pullRequestTitle) return title;
  return renderNaming(naming.setting, { type: record.type, scope: record.scope, change: ctx.change, title }).pullRequestTitle ?? title;
}

function recordOf(ctx: EventContext): ChangeRecord {
  const found = readRecord(ctx.folder);
  if (found) return found;
  return { version: 1, branch: branchOf(ctx.folder), type: 'feat', scope: changeScope(ctx.master, ctx.system, ctx.folder), base: ctx.base ?? 'main', pullRequests: [] };
}

/** Why the branch on a repository's remote is not this change's, or null when it is free or holds only this work. */
function remoteProblem(repo: string, path: string, branch: string, head: string): string | null {
  const url = gitOut(path, ['remote', 'get-url', 'origin']);
  if (!url) return `${repo} has no remote named origin to push to`;
  const listed = git(path, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (!listed.ok) return `${repo}'s remote cannot be reached: ${listed.stderr.trim()}`;
  const remoteHead = listed.stdout.trim().split(/\s/)[0];
  if (!remoteHead) return null;
  if (commitOf(path, remoteHead) !== null && isAncestor(path, remoteHead, head)) return null;
  return `${branch} is already taken on ${repo}'s remote by work that is not on this machine's branch: pick a new name with change rename, and nothing is pushed`;
}

/** The single-repo layout: the one repository is the change's copy (`ctx.master`), and an app is a folder of it. */
async function checkSingleRepo(ctx: EventContext): Promise<string[]> {
  const record = recordOf(ctx);
  const branch = record.branch;
  const planApps = planRepos(ctx.folder);
  if (planApps.length === 0) return [`${ctx.change} has no plan that reads cleanly, so there is nothing to declare done`];
  const problems: string[] = [];
  if (currentBranch(ctx.master) !== branch) problems.push(`the change's copy ${ctx.master} is on ${currentBranch(ctx.master) ?? 'a detached HEAD'}, not on ${branch}`);
  const dirty = dirtyPaths(ctx.master);
  if (dirty.length > 0) problems.push(`the change's copy has uncommitted files: ${dirty.join(', ')}`);
  for (const app of planApps) {
    const missing = unloggedTasks(ctx.folder, app) ?? [];
    if (missing.length > 0) problems.push(`${app} still has tasks without a build log entry: ${missing.join(', ')}`);
  }
  const base = baseBranch(ctx.master);
  if (base === null) problems.push(`the change's copy ${ctx.master} has no base branch to compare ${branch} with`);
  if (problems.length > 0 || base === null) return problems;
  const ref = `refs/heads/${branch}`;
  const folders = appFolders(ctx.master, ctx.system);
  const apps = touchedApps(ctx.master, ctx.system, ctx.master, base, ref);
  const headOfApp = (app: string): string => appHead(ctx.master, ref, folders[app] as string, base);
  const broken = commitRuleProblems(commitsBeyondBase(ctx.master, ref, base), changeScope(ctx.master, ctx.system, ctx.folder));
  if (broken.length > 0) problems.push(`commits on ${branch} break the commit rules: ${broken.join('; ')}`);
  const latest = latestReview(ctx.folder);
  const reviewed = latest === null ? null : Object.fromEntries(Object.entries(latest.commits ?? {}).map(([k, v]) => [k, String(v)]));
  if (latest === null || reviewed === null) problems.push(`${ctx.change} has no review yet: run the ai-sdlc review skill first`);
  else {
    const blocking = blockingFindings(latest);
    if (blocking.length > 0) problems.push(`the latest review (review ${latest.number}) has unresolved high findings: ${blocking.join('; ')}. Fix them and review again; a later review that no longer finds them clears them`);
    for (const app of apps) {
      const at = reviewed[app];
      const head = headOfApp(app);
      if (!at || !head.startsWith(at)) problems.push(`the latest review covered ${app} at ${at ?? 'no commit'}, but its branch is now at ${head.slice(0, 7)}: run the review again`);
    }
  }
  if (problems.length > 0) return problems;
  for (const app of apps) {
    const head = headOfApp(app);
    const checks = await runEvent({ ...ctx, event: 'build.finish', repo: app, repoPath: repoPathOf(ctx.master, ctx.workspace, ctx.system, app), root: ctx.master, branch, base, head, extra: {} });
    if (checks.outcome !== 'passed') problems.push(`${app}'s checks (build.finish) did not pass at ${head.slice(0, 7)}: ${[...checks.problems, checks.failed?.output ?? ''].filter(Boolean).join('\n')}`);
  }
  if (problems.length > 0) return problems;
  const remote = remoteProblem('master', ctx.master, branch, commitOf(ctx.master, 'HEAD') as string);
  if (remote) problems.push(remote);
  const signIn = signInProblem(ctx.master, hostOf(gitOut(ctx.master, ['remote', 'get-url', 'origin']) ?? ''));
  if (signIn) problems.push(signIn);
  return problems;
}

/** The single-repo layout: push the one branch, open (or keep) the one pull request, record it, push again. */
function actSingleRepo(ctx: EventContext) {
  const record = recordOf(ctx);
  const branch = record.branch;
  const base = baseBranch(ctx.master) ?? record.base;
  const touchedNames = touchedApps(ctx.master, ctx.system, ctx.master, base, `refs/heads/${branch}`);
  const untouched = planRepos(ctx.folder).filter((a) => !touchedNames.includes(a));
  const opened: PullRequest[] = [];
  const pushed: string[] = [];
  const fail = (why: string) => ({ problems: [why, pushed.length ? `pushed so far: ${pushed.join(', ')}; running done again carries on from there` : 'nothing was pushed'], details: { pushed, pullRequests: opened, untouched } });
  const push = (): string | null => {
    const r = git(ctx.master, ['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
    if (!r.ok) return `pushing ${branch} in master failed (a pre-push hook, or the remote refused it): ${(r.stderr || r.stdout).trim()}`;
    if (!pushed.includes('master')) pushed.push('master');
    return null;
  };
  const save = (header: string): string | null => {
    const file = writeRecord(ctx.folder, { ...record, pullRequests: opened });
    const r = commitPaths(ctx.master, [file], [header, 'Generated-By: ai-sdlc']);
    return r.ok || /nothing to commit|no changes added/.test(r.output) ? null : `the commit "${header}" failed: ${r.error}`;
  };
  const header = `docs(${record.scope}): record pull requests ${ctx.change}`;
  let failed = push();
  if (failed) return fail(failed);
  const names = touchedNames.map((a) => `\`${a}\``).join(', ');
  const body = `Change \`${ctx.change}\` of system \`${ctx.system}\`, built with ai-sdlc. Its intent, spec, plan, build logs and review are in this pull request, under \`intent/${ctx.system}/${ctx.change}/\`.\n\nApps touched: ${names || 'none'}.`;
  const pushedHead = commitOf(ctx.master, `refs/heads/${branch}`) as string;
  const pr = openPullRequest(ctx.master, branch) ?? openNew(ctx.master, { base, head: branch, title: pullRequestTitle(ctx, record), body });
  if (typeof pr === 'string') return fail(`opening the pull request in master failed: ${pr}`);
  opened.push({ repo: 'master', url: pr.url, number: pr.number, pushed: pushedHead });
  const saved = save(header);
  if (saved) return fail(saved);
  failed = push();
  if (failed) return fail(failed);
  ctx.head = commitOf(ctx.master, 'HEAD');
  return { problems: [], details: { pushed, pullRequests: opened, untouched } };
}

export const changeDone: Step = {
  reusePassed: false,
  async check(ctx) {
    if (isSingleRepo(ctx.master)) return checkSingleRepo(ctx);
    const record = recordOf(ctx);
    const branch = record.branch;
    const repos = planRepos(ctx.folder);
    if (repos.length === 0) return [`${ctx.change} has no plan that reads cleanly, so there is nothing to declare done`];
    const problems: string[] = [];
    if (currentBranch(ctx.master) !== branch) problems.push(`the master copy ${ctx.master} is on ${currentBranch(ctx.master) ?? 'a detached HEAD'}, not on ${branch}`);
    if (dirtyPaths(ctx.master).length > 0) problems.push(`the master copy has uncommitted files: ${dirtyPaths(ctx.master).join(', ')}`);
    for (const repo of repos.filter((r) => r !== 'master')) {
      const path = join(ctx.workspace, repo);
      const missing = unloggedTasks(ctx.folder, repo) ?? [];
      if (missing.length > 0) problems.push(`${repo} still has tasks without a build log entry: ${missing.join(', ')}`);
      if (!existsSync(join(path, '.git'))) problems.push(`${repo} is not checked out in ${ctx.workspace}`);
      else {
        if (!hasLocalBranch(path, branch)) problems.push(`${repo} has no branch ${branch}`);
        const dirty = dirtyPaths(path);
        if (dirty.length > 0) problems.push(`${repo} has uncommitted files: ${dirty.join(', ')}`);
      }
    }
    if (problems.length > 0) return problems;
    const repoList = touched(ctx, branch);
    const scope = changeScope(ctx.master, ctx.system, ctx.folder);
    for (const r of repoList) {
      const broken = commitRuleProblems(commitsBeyondBase(r.path, `refs/heads/${branch}`, baseBranch(r.path) as string), scope);
      if (broken.length > 0) problems.push(`commits on ${r.repo}'s ${branch} break the commit rules: ${broken.join('; ')}`);
    }
    const latest = latestReview(ctx.folder);
    const reviewed = latest === null ? null : Object.fromEntries(Object.entries(latest.commits ?? {}).map(([k, v]) => [k, String(v)]));
    if (latest === null || reviewed === null) problems.push(`${ctx.change} has no review yet: run the ai-sdlc review skill first`);
    else {
      const blocking = blockingFindings(latest);
      if (blocking.length > 0) problems.push(`the latest review (review ${latest.number}) has unresolved high findings: ${blocking.join('; ')}. Fix them and review again; a later review that no longer finds them clears them`);
      for (const r of repoList) {
        const at = reviewed[r.repo];
        if (!at || !r.head.startsWith(at)) problems.push(`the latest review covered ${r.repo} at ${at ?? 'no commit'}, but its branch is now at ${r.head.slice(0, 7)}: run the review again`);
      }
    }
    if (problems.length > 0) return problems;
    for (const r of repoList) {
      if (currentBranch(r.path) !== branch) {
        problems.push(`${r.repo} is not on ${branch}, so its checks cannot run on the work being declared done`);
        continue;
      }
      const checks = await runEvent({ ...ctx, event: 'build.finish', repo: r.repo, repoPath: r.path, root: r.path, branch, base: baseBranch(r.path), head: r.head, extra: {} });
      if (checks.outcome !== 'passed') problems.push(`${r.repo}'s checks (build.finish) did not pass at ${r.head.slice(0, 7)}: ${[...checks.problems, checks.failed?.output ?? ''].filter(Boolean).join('\n')}`);
    }
    if (problems.length > 0) return problems;
    const masterHead = commitOf(ctx.master, 'HEAD') as string;
    const hosts = new Set<string | null>();
    for (const r of [...repoList, { repo: 'master', path: ctx.master, head: masterHead }]) {
      const remote = remoteProblem(r.repo, r.path, branch, r.head);
      if (remote) problems.push(remote);
      hosts.add(hostOf(gitOut(r.path, ['remote', 'get-url', 'origin']) ?? ''));
    }
    for (const host of hosts) {
      const signIn = signInProblem(ctx.master, host);
      if (signIn) problems.push(signIn);
    }
    return problems;
  },
  act(ctx) {
    if (isSingleRepo(ctx.master)) return actSingleRepo(ctx);
    const record = recordOf(ctx);
    const branch = record.branch;
    const title = pullRequestTitle(ctx, record);
    const intro = `Change \`${ctx.change}\` of system \`${ctx.system}\`, built with ai-sdlc. Its intent, spec, plan, build logs and review are in the master repository's pull request.`;
    const opened: PullRequest[] = record.pullRequests.filter((p) => p.repo !== 'master');
    const pushed: string[] = [];
    const fail = (why: string) => ({ problems: [why, pushed.length ? `pushed so far: ${pushed.join(', ')}; running done again carries on from there` : 'nothing was pushed'], details: { pushed, pullRequests: opened } });

    const push = (repo: string, path: string): string | null => {
      const r = git(path, ['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
      if (!r.ok) return `pushing ${branch} in ${repo} failed (a pre-push hook, or the remote refused it): ${(r.stderr || r.stdout).trim()}`;
      pushed.push(repo);
      return null;
    };
    const pullRequest = (repo: string, path: string, body: string): PullRequest | string => {
      const head = commitOf(path, `refs/heads/${branch}`) as string;
      const base = baseBranch(path) ?? record.base;
      const existing = openPullRequest(path, branch);
      const pr = existing ?? openNew(path, { base, head: branch, title, body });
      if (typeof pr === 'string') return `opening the pull request in ${repo} failed: ${pr}`;
      return { repo, url: pr.url, number: pr.number, pushed: head };
    };
    const save = (header: string): string | null => {
      const file = writeRecord(ctx.folder, { ...record, pullRequests: opened });
      const r = commitPaths(ctx.master, [file], [header, 'Generated-By: ai-sdlc']);
      return r.ok || /nothing to commit|no changes added/.test(r.output) ? null : `the commit "${header}" failed: ${r.error}`;
    };

    for (const r of touched(ctx, branch)) {
      const failed = push(r.repo, r.path);
      if (failed) return fail(failed);
      const pr = pullRequest(r.repo, r.path, intro);
      if (typeof pr === 'string') return fail(pr);
      const i = opened.findIndex((p) => p.repo === r.repo);
      if (i >= 0) opened[i] = pr;
      else opened.push(pr);
    }
    const header = `docs(${record.scope}): record pull requests ${ctx.change}`;
    const saved = save(header);
    if (saved) return fail(saved);
    let failed = push('master', ctx.master);
    if (failed) return fail(failed);
    const list = opened.map((p) => `- ${p.repo}: ${p.url}`).join('\n');
    const masterPr = pullRequest('master', ctx.master, `Change \`${ctx.change}\` of system \`${ctx.system}\`: its intent, spec, plan, build logs and review, built with ai-sdlc.${list ? `\n\nThe change's pull requests:\n${list}` : ''}`);
    if (typeof masterPr === 'string') return fail(masterPr);
    opened.push(masterPr);
    const savedAgain = save(header);
    if (savedAgain) return fail(savedAgain);
    failed = push('master', ctx.master);
    if (failed) return fail(failed);
    ctx.head = commitOf(ctx.master, 'HEAD');
    return { problems: [], details: { pushed: [...new Set(pushed)], pullRequests: opened } };
  },
};

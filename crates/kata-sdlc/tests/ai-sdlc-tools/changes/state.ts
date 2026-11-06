// `state --json`: where every change of a system stands, from its documents and git, and per skill whether that skill
// may work on it (`ready`). This is the one place a skill's gate is computed; GRAMMAR.md ("Where a change stands")
// defines every field. It only reads: git runs without optional locks, and nothing is written.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CouldNotRun } from '../common/types.ts';
import { readReview } from '../documents/review.ts';
import { readSpec } from '../documents/spec.ts';
import { baseBranch, baseRevision, commitOf, commitsWithTrailer, mergeBase } from '../git/git.ts';
import { uncommittedFiles } from '../workspace/own-files.ts';
import { gitDirs, type ResolveOptions } from '../workspace/resolve.ts';
import { DIFF_OPTIONS, differsFromHead, fieldOf, fixStateOf, git, readable, statusOf, type FixState } from './fix-state.ts';
import { finishedOf, type Finished } from './finished.ts';
import { placeChanges, titleAndTrack } from './place.ts';
import { entriesOf, tasksOf } from './progress.ts';
import { SystemRead } from './system-read.ts';

type Doc = 'intent' | 'spec' | 'plan';
const DOCS: readonly Doc[] = ['intent', 'spec', 'plan'];
const FILE: Record<Doc, string> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' };

export type DocumentState = { exists: boolean; inHead: boolean; headStatus: string | null; workingStatus: string | null; uncommitted: boolean };
export type Pin = 'holds' | 'broken' | 'missing';
export type PinnedDocumentState = DocumentState & { pin: Pin | null };
export type Ready = { candidate: boolean; stop: string | null; accept: string[] };
export type Skill = 'spec' | 'plan' | 'build' | 'review' | 'done' | 'reject';
export type BuildLogState = 'clean' | 'added-entries' | 'other';

export type ChangeState = {
  change: string;
  master: string;
  folder: string;
  inCopy: boolean;
  title: string | null;
  track: 'full' | 'fix';
  documents: { intent: DocumentState; spec: PinnedDocumentState; plan: PinnedDocumentState };
  scenarios: number | null;
  tasks: Record<string, TaskState> | null;
  buildLogs: Record<string, BuildLogState>;
  review: { committed: number; draft: 'none' | 'next-section' | 'other' };
  fix: FixState | null;
  ready: Record<Skill, Ready>;
  /** Null when open; see GRAMMAR.md ("Listing a system's changes"). */
  finished: Finished;
};

export type TaskState = {
  all: string[];
  logged: string[];
  unlogged: string[];
  commits: Record<string, string[]> | null;
  untasked: string[] | null;
  uncommitted: string[] | null;
};

export type StateResult = { system: string; changes: ChangeState[]; problems: string[] };

export type StateOptions = ResolveOptions & { system?: string; change?: string; open?: boolean };

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The commit a source pin names, or null when the field is absent, empty, `pending acceptance` or not a commit name. */
function pinValue(text: string | null, file: string, field: string): string | null {
  const value = text === null ? undefined : fieldOf(text, file, field);
  const sha = value === undefined || value === null ? '' : String(value).trim();
  return sha === '' || sha === 'pending acceptance' || sha.startsWith('-') ? null : sha;
}

/** What one `changeStates` call learns once and reuses: git directories by folder and each repository's work by path. */
type RunCache = {
  dirs: Map<string, ReturnType<typeof gitDirs>>;
  work: Map<string, RepositoryFacts>;
};

type RepositoryFacts = {
  uncommitted: string[];
  /** The merge base with the base branch; null without a base or a `HEAD`. */
  from: string | null;
  trailers: { sha: string; values: string[] }[];
};

const newRun = (): RunCache => ({ dirs: new Map(), work: new Map() });

function dirsOf(run: RunCache, dir: string): ReturnType<typeof gitDirs> {
  if (!run.dirs.has(dir)) run.dirs.set(dir, gitDirs(dir));
  return run.dirs.get(dir) ?? null;
}

const STOP = {
  uncommitted: (file: string) => `\`${file}\` has uncommitted changes. Commit the acceptance first, so history shows what was accepted.`,
  light: (change: string) => `\`${change}\` is on the light track; \`fix --accept ${change}\` finishes or revises its documents.`,
  intentNot: (s: string) => `This intent is \`${s}\`. The product owner accepts it by changing its status to \`accepted\` and committing; the spec runs only after that.`,
  specNot: (s: string) => `This spec is \`${s}\`. The product owner accepts it by changing its status to \`accepted\` and committing.`,
  intentReopened: (s: string) => `The intent was reopened (\`${s}\`). The spec must be regenerated and accepted again before planning.`,
  specPinMissing: 'This spec does not record the intent it was written from. Rerun the spec skill; the product owner accepts it again before planning.',
  specPinBroken: 'This spec was written from an earlier version of the intent. Rerun the spec skill; the product owner accepts it again before planning.',
  noScenarios: 'This spec has no Gherkin scenarios. Rerun the spec skill to regenerate it; the product owner accepts it again before planning.',
  planNot: (s: string) => `This plan is \`${s}\`. The engineer accepts it by changing its status to \`accepted\` and committing.`,
  reopened: (file: string, s: string) => `\`${file}\` was reopened (\`${s}\`). Rerun the skills after it, then accept the plan again.`,
  buildSpecPin: 'The intent changed after this spec was written. Rerun the spec skill, then the plan skill.',
  buildPlanPin: 'This plan was not written from the spec that is accepted now. Rerun the plan skill.',
  planUnreadable: 'This plan cannot be read. Rerun the plan skill.',
  unlogged: (list: string) => `These tasks have no build log entry yet: ${list}.`,
  closed: (change: string) => `\`${change}\` is closed: its intent was rejected.`,
  rejectUncommitted: (file: string) => `\`${file}\` has uncommitted changes. Commit or discard them first, so the rejection does not carry them unread.`,
  built: (change: string) => `\`${change}\` has build work (a build log or a review), so it is not rejected. The engineer settles that work first.`,
  logDirty: (repo: string) => `The build log for \`${repo}\` has uncommitted changes; rerun the build for \`${repo}\` to commit them.`,
};

/** Whether every difference `git diff HEAD --unified=0` shows for the file is an added line. */
function onlyAddedLines(top: string, path: string): boolean {
  const out = git(top, ['diff', 'HEAD', ...DIFF_OPTIONS, '--no-color', '--unified=0', '--', path]);
  let inHunks = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) inHunks = true;
    else if (inHunks && (line.startsWith('-') || line.startsWith('\\'))) return false;
  }
  return true;
}

/** Reads where one change stands, in the repository (master or copy) that holds it. */
function changeState(read: SystemRead, run: RunCache, workspace: string, change: string, inCopy: boolean, problems: string[]): Omit<ChangeState, 'finished'> {
  const { top, system, hasHead } = read;
  const prefix = `intent/${system}/${change}/`;
  const folder = join(top, 'intent', system, change);
  const inHead = new Set(read.headPaths(prefix));
  const reported = new Set([...read.reported].filter((p) => p.startsWith(prefix)));
  const headText = (name: string): string | null => read.headText(prefix + name);
  const workingText = (name: string): string | null => readText(join(folder, name));
  const uncommitted = (name: string): boolean => reported.has(prefix + name) && (!inHead.has(prefix + name) || differsFromHead(top, prefix + name));

  const texts = Object.fromEntries(DOCS.map((d) => [d, { head: headText(FILE[d]), working: workingText(FILE[d]) }])) as Record<Doc, { head: string | null; working: string | null }>;
  const facts = (d: Doc): DocumentState => {
    const { head, working } = texts[d];
    return {
      exists: working !== null,
      inHead: head !== null,
      headStatus: head === null ? null : statusOf(head, `HEAD:${prefix}${FILE[d]}`),
      workingStatus: working === null ? null : statusOf(working, join(folder, FILE[d])),
      uncommitted: uncommitted(FILE[d]),
    };
  };
  const pin = (d: 'spec' | 'plan'): Pin | null => {
    const working = texts[d].working;
    if (working === null) return null;
    const sha = pinValue(working, join(folder, FILE[d]), d === 'spec' ? 'source_intent_commit' : 'source_spec_commit');
    if (sha === null) return 'missing';
    if (!hasHead || read.objectOf(`${sha}^{commit}`) === null) return 'missing';
    const path = prefix + (d === 'spec' ? FILE.intent : FILE.spec);
    // Content only: a difference in file mode alone does not break the pin.
    return read.objectOf(`${sha}:${path}`) !== (read.headBlobs.get(path) ?? null) ? 'broken' : 'holds';
  };
  const documents = { intent: facts('intent'), spec: { ...facts('spec'), pin: pin('spec') }, plan: { ...facts('plan'), pin: pin('plan') } };

  const { title, track } = titleAndTrack(texts.intent.working, texts.intent.head, join(folder, FILE.intent), `HEAD:${prefix}${FILE.intent}`);

  const specFile = join(folder, FILE.spec);
  const specRead = texts.spec.working === null ? null : readable(() => readSpec(texts.spec.working as string, specFile));
  const scenarios = specRead?.kind === 'spec' && specRead.problems.length === 0 ? specRead.document.requirements.reduce((n, r) => n + r.scenarios.length, 0) : null;

  // Tasks: the plan and the build logs as committed. A task is logged when any build log in HEAD has its entry.
  const isLog = (name: string): boolean => name.endsWith('.md') && name !== 'review.md' && !name.includes('/');
  const headLogs = [...inHead].filter((p) => p.startsWith(`${prefix}build/`)).map((p) => p.slice(`${prefix}build/`.length)).filter(isLog);
  const planHead = texts.plan.head;
  const planTasks = planHead === null ? null : readable(() => tasksOf(planHead, join(folder, FILE.plan)));
  let tasks: ChangeState['tasks'] = null;
  if (planTasks) {
    const logged = new Set<string>();
    for (const name of headLogs) {
      const entries = readable(() => entriesOf(headText(`build/${name}`) as string, join(folder, 'build', name)));
      for (const id of entries ?? []) logged.add(id);
    }
    tasks = {};
    for (const t of planTasks) {
      const entry = (tasks[t.repo] ??= { all: [], logged: [], unlogged: [], commits: null, untasked: null, uncommitted: null });
      entry.all.push(t.id);
      (logged.has(t.id) ? entry.logged : entry.unlogged).push(t.id);
    }
    for (const [repo, entry] of Object.entries(tasks)) Object.assign(entry, repositoryWork(top, workspace, repo, entry.all, run));
  }

  const workingLogs = isDir(join(folder, 'build')) ? readdirSync(join(folder, 'build')).filter(isLog) : [];
  const buildLogs: Record<string, BuildLogState> = {};
  for (const name of [...new Set([...headLogs, ...workingLogs])].sort()) {
    const path = `${prefix}build/${name}`;
    const repo = name.slice(0, -'.md'.length);
    if (!uncommitted(`build/${name}`)) buildLogs[repo] = 'clean';
    else if (!inHead.has(path)) buildLogs[repo] = existsSync(join(folder, 'build', name)) ? 'added-entries' : 'other';
    else buildLogs[repo] = existsSync(join(folder, 'build', name)) && onlyAddedLines(top, path) ? 'added-entries' : 'other';
  }

  const reviewFile = join(folder, 'build', 'review.md');
  const reviewHead = headText('build/review.md');
  const headReview = reviewHead === null ? null : readable(() => readReview(reviewHead, reviewFile));
  const committed = headReview?.kind === 'review' ? headReview.document.reviews.length : 0;
  let draft: ChangeState['review']['draft'] = 'none';
  if (uncommitted('build/review.md')) {
    draft = 'other';
    const working = workingText('build/review.md');
    const draftRead = working === null ? null : readable(() => readReview(working, reviewFile));
    if (working !== null && draftRead?.kind === 'review' && draftRead.problems.length === 0 && draftRead.document.reviews.length === committed + 1) {
      const appended = reviewHead === null ? null : working.startsWith(reviewHead) ? working.slice(reviewHead.length) : null;
      const next = new RegExp(`^(\\r?\\n)*## Review ${committed + 1}[ \\t]*\\r?(\\n|$)`);
      if (reviewHead === null || (appended !== null && next.test(appended))) draft = 'next-section';
    }
  }

  let fix: FixState | null = null;
  if (track === 'fix') {
    try {
      // `fix-state` refuses a folder that is not on disk, even when HEAD still holds its documents; so does `state`.
      if (!isDir(folder)) throw new CouldNotRun(`${folder} does not exist`);
      fix = fixStateOf({ top, prefix, folder, hasHead, headText: (p) => read.headText(p), headPaths: (d) => read.headPaths(d), reported: read.reported });
    } catch (e) {
      if (!(e instanceof CouldNotRun)) throw e;
      problems.push(`${change}: ${e.message}`);
    }
  }

  const base: Omit<ChangeState, 'ready' | 'finished'> = { change, master: top, folder, inCopy, title, track, documents, scenarios, tasks, buildLogs, review: { committed, draft }, fix };
  return { ...base, ready: readiness(base) };
}

/**
 * A plan repository's work: its commits from the merge base with its base branch to `HEAD`, oldest first, by
 * `Plan-Task` trailer (`untasked` those without one), and its uncommitted files. The repository is
 * `<workspace>/<repo>`, except the master listed as a product repository, which is read where the change is (its
 * copy, when it has one). Null when the repository is not checked out; `commits` and `untasked` null without a base.
 */
function repositoryWork(top: string, workspace: string, repo: string, ids: string[], run: RunCache): Pick<TaskState, 'commits' | 'untasked' | 'uncommitted'> {
  const listed = join(workspace, repo);
  if (!existsSync(join(listed, '.git'))) return { commits: null, untasked: null, uncommitted: null };
  const common = dirsOf(run, listed)?.common;
  const path = common !== undefined && common === dirsOf(run, top)?.common ? top : listed;
  let facts = run.work.get(path);
  if (facts === undefined) {
    const uncommitted = uncommittedFiles(path);
    const base = baseBranch(path);
    const baseRev = base === null ? null : baseRevision(path, base);
    const from = baseRev === null || commitOf(path, 'HEAD') === null ? null : mergeBase(path, baseRev, 'HEAD');
    facts = { uncommitted, from, trailers: from === null ? [] : commitsWithTrailer(path, from, 'HEAD', 'Plan-Task') };
    run.work.set(path, facts);
  }
  if (facts.from === null) return { commits: null, untasked: null, uncommitted: facts.uncommitted };
  const commits: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
  const untasked: string[] = [];
  for (const c of facts.trailers) {
    if (c.values.length === 0) untasked.push(c.sha);
    for (const id of new Set(c.values)) commits[id]?.push(c.sha);
  }
  return { commits, untasked, uncommitted: facts.uncommitted };
}

/** Every skill's gate for a change, by the rules in GRAMMAR.md ("Where a change stands"). */
function readiness(c: Omit<ChangeState, 'ready' | 'finished'>): Record<Skill, Ready> {
  const d = c.documents;
  const status = (doc: Doc): string => d[doc].workingStatus ?? 'missing';
  const accepted = (doc: Doc): boolean => d[doc].workingStatus === 'accepted';
  const uncommittedAcceptance = (docs: Doc[]): string | null => {
    const doc = docs.find((x) => accepted(x) && d[x].uncommitted);
    return doc === undefined ? null : STOP.uncommitted(FILE[doc]);
  };
  const accept = (docs: Doc[]): string[] => docs.filter((x) => d[x].headStatus === 'accepted' && accepted(x) && !d[x].uncommitted).map((x) => FILE[x]);
  const first = (...stops: (() => string | null)[]): string | null => {
    for (const s of stops) {
      const stop = s();
      if (stop !== null) return stop;
    }
    return null;
  };
  const when = (cond: boolean, stop: string): (() => string | null) => () => (cond ? stop : null);
  const light = c.track === 'fix';
  const pinFails = (doc: 'spec' | 'plan'): boolean => d[doc].pin !== 'holds';
  const unloggedRepos = Object.entries(c.tasks ?? {}).filter(([, t]) => t.unlogged.length > 0);

  const specStop = first(
    when(light, STOP.light(c.change)),
    when(!accepted('intent'), STOP.intentNot(status('intent'))),
    () => uncommittedAcceptance(['intent']),
  );
  const planStop = first(
    when(light, STOP.light(c.change)),
    when(!accepted('spec'), STOP.specNot(status('spec'))),
    when(!accepted('intent'), STOP.intentReopened(status('intent'))),
    () => uncommittedAcceptance(['intent', 'spec']),
    when(d.spec.pin === 'missing', STOP.specPinMissing),
    when(d.spec.pin === 'broken', STOP.specPinBroken),
    when(!c.scenarios, STOP.noScenarios),
  );
  const buildStop = first(
    when(!accepted('plan'), STOP.planNot(status('plan'))),
    when(!accepted('intent'), STOP.reopened(FILE.intent, status('intent'))),
    when(!accepted('spec'), STOP.reopened(FILE.spec, status('spec'))),
    () => uncommittedAcceptance(['intent', 'spec', 'plan']),
    when(pinFails('spec'), STOP.buildSpecPin),
    when(pinFails('plan'), STOP.buildPlanPin),
    when(c.tasks === null, STOP.planUnreadable),
  );
  const dirtyLog = Object.entries(c.buildLogs).find(([, s]) => s !== 'clean');
  const reviewStop = first(
    () => buildStop,
    when(unloggedRepos.length > 0, STOP.unlogged(unloggedRepos.map(([repo, t]) => `\`${repo}\`: ${t.unlogged.join(', ')}`).join('; '))),
    when(dirtyLog !== undefined, STOP.logDirty(dirtyLog?.[0] ?? '')),
  );
  const allLogged = c.tasks !== null && unloggedRepos.length === 0;
  const rejectStop = first(
    when(d.intent.headStatus === 'rejected', STOP.closed(c.change)),
    when(Object.keys(c.buildLogs).length > 0 || c.review.committed > 0 || c.review.draft !== 'none', STOP.built(c.change)),
    () => {
      const doc = DOCS.find((x) => d[x].uncommitted);
      return doc === undefined ? null : STOP.rejectUncommitted(FILE[doc]);
    },
  );

  return {
    spec: {
      candidate: specStop === null && (!d.spec.exists || !accepted('spec') || pinFails('spec')),
      stop: specStop,
      accept: accept(['intent']),
    },
    plan: { candidate: planStop === null && (!d.plan.exists || d.plan.workingStatus === 'superseded'), stop: planStop, accept: accept(['intent', 'spec']) },
    build: { candidate: buildStop === null && unloggedRepos.length > 0, stop: buildStop, accept: accept(['intent', 'spec', 'plan']) },
    review: { candidate: reviewStop === null, stop: reviewStop, accept: accept(['intent', 'spec', 'plan']) },
    done: { candidate: c.review.committed > 0 && allLogged, stop: null, accept: [] },
    reject: { candidate: false, stop: rejectStop, accept: [] },
  };
}

/** Where every change of a system stands (or only `options.change`, or only the open ones with `options.open`), in the master and in every change copy. */
export function changeStates(cwd: string, options: StateOptions): StateResult {
  const run = newRun();
  const place = placeChanges(cwd, options, run.dirs);
  const { system, workspace, reads, placed } = place;
  const problems: string[] = [];

  // Which changes are finished comes first: it loads only the intent texts, so with `open` the rest of a finished
  // change's documents are never read.
  const finished = finishedOf(place);
  const reported = options.open ? placed.filter(({ change }) => (finished.get(change) ?? null) === null) : placed;

  // Every document text and every source pin of the reported changes, each answered in one git process per repository.
  const pins = new Map<string, string[]>();
  const loads = new Map<string, string[]>();
  for (const { change, top } of reported) {
    const prefix = `intent/${system}/${change}/`;
    loads.set(top, [...(loads.get(top) ?? []), ...(reads.get(top) as SystemRead).headPaths(prefix).filter((p) => p.endsWith('.md'))]);
    for (const [doc, field, upstream] of [['spec.md', 'source_intent_commit', 'intent.md'], ['plan.md', 'source_spec_commit', 'spec.md']] as const) {
      const file = join(top, 'intent', system, change, doc);
      const sha = pinValue(readText(file), file, field);
      if (sha === null) continue;
      pins.set(top, [...(pins.get(top) ?? []), `${sha}^{commit}`, `${sha}:${prefix}${upstream}`]);
    }
  }
  for (const [top, paths] of loads) (reads.get(top) as SystemRead).loadTexts(paths);
  // A repository without a HEAD answers every pin `missing` without asking git.
  for (const [top, list] of pins) if ((reads.get(top) as SystemRead).hasHead) (reads.get(top) as SystemRead).resolve(list);

  const changes = reported.map(({ change, top, inCopy }) => ({
    ...changeState(reads.get(top) as SystemRead, run, workspace, change, inCopy, problems),
    finished: finished.get(change) ?? null,
  }));
  return { system, changes, problems };
}

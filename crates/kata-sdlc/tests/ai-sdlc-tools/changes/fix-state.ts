// `fix-state --json <change folder>...`: where a fix stands, by the fix-state table in GRAMMAR.md, and the facts behind it.
// This is the one place the row is computed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readBuildLog } from '../documents/build-log.ts';
import { frontMatterCloseLine, parseFrontMatter } from '../documents/front-matter.ts';
import { findMarker } from '../workspace/marker.ts';
import { readPlan } from '../documents/plan.ts';
import { CouldNotRun } from '../common/types.ts';

export type FixDocument = 'intent' | 'spec' | 'plan';

const DOCUMENTS: readonly FixDocument[] = ['intent', 'spec', 'plan'];

/** The front matter lines an acceptance writes on a document. */
const OWN_LINES = ['status', 'source_intent_commit', 'source_spec_commit', 'accepted_in_advance'];

export type DocumentFacts = {
  /** The document's file is in `HEAD`. */
  inHead: boolean;
  /** The `status` of the `HEAD` copy; null when `HEAD` does not hold it or its front matter names none. */
  headStatus: string | null;
  /** The `status` of the working copy; null when there is no working copy or it names none. */
  workingStatus: string | null;
};

export type FixFacts = Record<FixDocument, DocumentFacts> & {
  /** The documents with unrecorded changes, in document order. */
  unrecorded: FixDocument[];
  /** Some document differs from `HEAD`, and only in own lines. */
  ownLinesOnly: boolean;
  /** Which documents are accepted in `HEAD`: none, a leading run, all three, or some other set. */
  accepted: 'none' | 'leading' | 'all' | 'other';
  /** The latest commit touching any of the three documents is an acceptance. */
  acceptanceLast: boolean;
  /** Some task of the plan in `HEAD` has an entry in a build log in `HEAD`; false on rows 1 and 2, decided before it. */
  built: boolean;
};

export type FixState = { row: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; facts: FixFacts };

/** One entry of the batch form: the folder as given, and its state or the reason it could not be read. */
export type FixStateEntry = { folder: string; result: FixState } | { folder: string; error: string };

/** Every git call: paths printed as they are, and no lock taken for a refresh nobody asked for. */
export const GIT_OPTIONS = ['-c', 'core.quotepath=off', '--no-optional-locks'];

/** Every `git diff`: git's own comparison, whatever external diff tool or text conversion the user configured. */
export const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv'];

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...GIT_OPTIONS, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const detail = (err.stderr ?? '').trim() || err.message;
    throw new CouldNotRun(`git ${args[0]} failed in ${cwd}: ${detail}`);
  }
}

/** Like `git`, but a non-zero exit is an answer (null), not a failure. Only a git that cannot start is one. */
export function gitMaybe(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', [...GIT_OPTIONS, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if ((e as { status?: number | null }).status == null) {
      throw new CouldNotRun(`git could not run in ${cwd}: ${(e as Error).message}`);
    }
    return null;
  }
}

/** A front matter field of a document's text; undefined when it has none or its front matter cannot be read. */
export function fieldOf(text: string, file: string, field: string): unknown {
  try {
    return parseFrontMatter(text, file).data[field];
  } catch {
    return undefined;
  }
}

/** The `status` field of a document's text; null when it has none or its front matter cannot be read. */
export function statusOf(text: string, file: string): string | null {
  const value = fieldOf(text, file, 'status');
  return value === undefined || value === null ? null : String(value);
}

const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/;

/**
 * Whether the document differs from its `HEAD` copy only in own lines, by git's own comparison
 * (`git diff HEAD --unified=0`, after git's line-ending conversion, with external diff tools and text conversion
 * turned off): every removed and added line is one of the front matter lines an acceptance writes, an added
 * `status` line reads `accepted`, and no line's ending or the final newline changed. An added line ends as the
 * `HEAD` line it replaces does (or, with none to replace, as the `HEAD` line before it).
 */
function onlyOwnLines(top: string, path: string, headText: string, workingText: string): boolean {
  const out = git(top, ['diff', 'HEAD', ...DIFF_OPTIONS, '--no-color', '--unified=0', '--', path]);
  const headLines = headText.split('\n');
  const ends = { '-': frontMatterCloseLine(headText), '+': frontMatterCloseLine(workingText) };
  const next = { '-': 0, '+': 0 };
  let oldStart = 0;
  let oldCount = 0;
  let added = 0;
  let inHunks = false;
  let statusAccepted = false;
  for (const line of out.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHunks = true;
      oldStart = Number(hunk[1]);
      oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      next['-'] = oldStart;
      next['+'] = Number(hunk[3]);
      added = 0;
      continue;
    }
    if (!inHunks || line === '') continue; // the file's headers, and the text after the last newline
    const side = line[0];
    if (side !== '-' && side !== '+') return false; // "\ No newline at end of file", or anything unexpected
    const number = next[side]++;
    let text = line.slice(1);
    if (side === '+') {
      // The HEAD line this one stands in for: the one it replaces, else the last line of the removed run, else the
      // line the insertion follows (a hunk that removes nothing names that line as its start).
      const index = added < oldCount ? oldStart - 1 + added : oldCount > 0 ? oldStart + oldCount - 2 : oldStart - 1;
      added++;
      const expectsCr = (headLines[index] ?? '').endsWith('\r');
      if (expectsCr !== text.endsWith('\r')) return false;
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    const field = FIELD_LINE.exec(text);
    if (!field || number < 2 || number >= ends[side] || !OWN_LINES.includes(field[1] as string)) return false;
    if (side === '+' && field[1] === 'status') {
      if ((field[2] as string).trim() !== 'accepted') return false;
      statusAccepted = true;
    }
  }
  return statusAccepted;
}

/** The paths `git status --porcelain=v1 -z` reports, relative to the repository's top level. */
export function reportedPaths(top: string, paths: string[]): Set<string> {
  const out = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]);
  const reported = new Set<string>();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    reported.add(field.slice(3));
    // A rename or copy is followed by the path it came from.
    if (field[0] === 'R' || field[0] === 'C') reported.add(fields[++i] as string);
  }
  return reported;
}

/** Whether git would record a difference between the working copy and `HEAD` (`git diff --quiet HEAD` exits 1). */
export function differsFromHead(top: string, path: string): boolean {
  return differs(top, ['HEAD'], path);
}

/** Whether `git diff --quiet <revs> -- <path>` finds a difference (exits 1); any other failure stops the program. */
export function differs(top: string, revs: string[], path: string): boolean {
  try {
    execFileSync('git', [...GIT_OPTIONS, 'diff', '--quiet', ...revs, ...DIFF_OPTIONS, '--', path], { cwd: top, stdio: ['ignore', 'ignore', 'pipe'] });
    return false;
  } catch (e) {
    const err = e as { status?: number | null; stderr?: Buffer; message: string };
    if (err.status === 1) return true;
    const detail = (err.stderr?.toString() ?? '').trim() || err.message;
    throw new CouldNotRun(`git diff failed in ${top}: ${detail}`);
  }
}

/** Runs a reader; a document it cannot read (broken front matter, a newer layout) is null, so it counts as not built. */
export function readable<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if (e instanceof CouldNotRun) return null;
    throw e;
  }
}

/** What the fix-state rules need to know about one fix, from any reader: git directly, or a batch read of the system. */
export type FixInput = {
  top: string;
  /** The change folder relative to `top`, with forward slashes and a trailing slash. */
  prefix: string;
  folder: string;
  hasHead: boolean;
  /** The text of a path in `HEAD`, exactly as stored; null when `HEAD` does not have it. */
  headText(path: string): string | null;
  /** Every path in `HEAD` under `dir` (a folder path with a trailing slash). */
  headPaths(dir: string): string[];
  /** The paths git reports as changed; only the fix's three documents are ever asked about. */
  reported: Set<string>;
};

/** Whether some task of the plan in `HEAD` has an entry in a build log in `HEAD`. `build/review.md` is not a log. */
function isBuilt(input: FixInput): boolean {
  const { prefix, folder } = input;
  const planText = input.headText(`${prefix}plan.md`);
  if (planText === null) return false;
  const planFile = join(folder, 'plan.md');
  const planResult = readable(() => readPlan(planText, planFile, findMarker(planFile)));
  if (planResult?.kind !== 'plan') return false;
  const tasks = new Set(planResult.document.tasks.map((t) => t.id));
  if (tasks.size === 0) return false;
  const dir = `${prefix}build/`;
  // Direct children only: the folder holds the build logs, one per repository, and `review.md`.
  const logs = input
    .headPaths(dir)
    .filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && p.endsWith('.md') && !p.endsWith('/review.md'));
  return logs.some((path) => {
    const text = input.headText(path);
    if (text === null) return false;
    const result = readable(() => readBuildLog(text, join(folder, 'build', basename(path))));
    return result?.kind === 'build-log' && result.document.entries.some((e) => tasks.has(e.task));
  });
}

/** The row of the fix-state table: rows in order, first match wins. */
export function rowOf(facts: FixFacts): FixState['row'] {
  const docs = DOCUMENTS.map((d) => facts[d]);
  if (facts.intent.headStatus === 'rejected') return 1;
  const oddStatus = docs.some((d) => d.inHead && d.headStatus !== 'draft' && d.headStatus !== 'accepted');
  const someAccepted = facts.accepted !== 'none';
  if (oddStatus || facts.accepted === 'other' || (someAccepted && docs.some((d) => !d.inHead))) return 2;
  if (facts.unrecorded.length > 0) return 3;
  if (facts.ownLinesOnly) return 4;
  if (facts.accepted === 'leading' && facts.acceptanceLast) return 5;
  if (facts.accepted === 'none' && !facts.built) return 6;
  if (facts.accepted !== 'all') return 7;
  return 8;
}

/** Reads where the fix in `folder` stands, asking git in the repository that holds it. */
export function fixState(folderArg: string): FixState {
  const folder = resolve(folderArg);
  if (!existsSync(folder)) throw new CouldNotRun(`${folderArg} does not exist`);
  if (!statSync(folder).isDirectory()) throw new CouldNotRun(`${folderArg} is not a folder`);
  const top = git(folder, ['rev-parse', '--show-toplevel']).trim();
  // The folder relative to the top level, with forward slashes and a trailing slash ('' at the top itself).
  const prefix = git(folder, ['rev-parse', '--show-prefix']).trim();
  const hasHead = gitMaybe(top, ['rev-parse', '--verify', '-q', 'HEAD']) !== null;
  const texts = new Map<string, string | null>();
  const paths = DOCUMENTS.map((d) => `${prefix}${d}.md`);
  let reported: Set<string> | null = null;
  return fixStateOf({
    top,
    prefix,
    folder,
    hasHead,
    headText(path) {
      if (!texts.has(path)) {
        const inHead = hasHead && git(top, ['ls-tree', '--name-only', 'HEAD', '--', path]).trim() !== '';
        texts.set(path, inHead ? git(top, ['show', `HEAD:${path}`]) : null);
      }
      return texts.get(path) ?? null;
    },
    headPaths(dir) {
      return git(top, ['ls-tree', '-z', '--name-only', 'HEAD', '--', dir]).split('\0').filter((p) => p !== '');
    },
    // Asked only after the track check, as git status was before the split.
    get reported() {
      return (reported ??= reportedPaths(top, paths));
    },
  });
}

/** The state of the fix in `input.folder`, by the fix-state table; every fact about `HEAD` comes from the input. */
export function fixStateOf(input: FixInput): FixState {
  const { top, prefix, folder, hasHead } = input;
  const paths = DOCUMENTS.map((d) => `${prefix}${d}.md`);
  const head = paths.map((p) => (hasHead ? input.headText(p) : null));
  const working = DOCUMENTS.map((d) => {
    try {
      return readFileSync(join(folder, `${d}.md`), 'utf8');
    } catch {
      return null;
    }
  });

  // The track comes from the working intent, or from HEAD's when the working copy is missing or names none.
  const intentFile = join(folder, 'intent.md');
  if (working[0] == null && head[0] == null) {
    throw new CouldNotRun(`${intentFile}: cannot read the intent: there is no intent.md in the working tree or in HEAD`);
  }
  const trackIn = (text: string | null, file: string): unknown => (text == null ? undefined : fieldOf(text, file, 'track'));
  let track = trackIn(working[0] ?? null, intentFile);
  if (track === undefined || track === null) track = trackIn(head[0] ?? null, `HEAD:${paths[0]}`);
  if (track !== 'fix') {
    throw new CouldNotRun(
      `${intentFile}: not a fix (its track is ${track === undefined || track === null ? 'not set' : JSON.stringify(track)}, expected fix)`,
    );
  }

  const perDoc: DocumentFacts[] = DOCUMENTS.map((d, i) => ({
    inHead: head[i] !== null,
    headStatus: head[i] == null ? null : statusOf(head[i] as string, `HEAD:${paths[i]}`),
    workingStatus: working[i] == null ? null : statusOf(working[i] as string, join(folder, `${d}.md`)),
  }));

  const acceptedInHead = perDoc.map((d) => d.inHead && d.headStatus === 'accepted');
  const count = acceptedInHead.filter(Boolean).length;
  const leading = count > 0 && acceptedInHead.slice(0, count).every(Boolean);
  const accepted: FixFacts['accepted'] = count === 0 ? 'none' : count === 3 ? 'all' : leading ? 'leading' : 'other';

  const subject = hasHead ? git(top, ['log', '-1', '--format=%s', '--', ...paths]).trim() : '';
  const change = basename(folder);
  const acceptanceLast = DOCUMENTS.some((d) => subject.endsWith(`accept ${d} ${change}`));
  const [intentFacts, specFacts, planFacts] = perDoc as [DocumentFacts, DocumentFacts, DocumentFacts];
  const facts: FixFacts = {
    intent: intentFacts,
    spec: specFacts,
    plan: planFacts,
    unrecorded: [],
    ownLinesOnly: false,
    accepted,
    acceptanceLast,
    built: false,
  };

  // Differences are what git reports, so git's own line-ending conversion is never one.
  const reported = input.reported;
  // Rows 1 and 2 are decided from the statuses in HEAD alone, before any diff is run and before the plan and the
  // build logs are read, so nothing a later row needs can hide a rejected or unsettled fix. On those rows
  // `unrecorded` lists the documents not in HEAD and every one git reports, and `ownLinesOnly` is false.
  const early = rowOf(facts);
  if (early === 1 || early === 2) {
    facts.unrecorded = DOCUMENTS.filter((_, i) => !perDoc[i]!.inHead || reported.has(paths[i] as string));
    return { row: early, facts };
  }

  // Only the first document not accepted in HEAD may carry an acceptance's own lines.
  const carrier = acceptedInHead.findIndex((a) => !a);
  const unrecorded: FixDocument[] = [];
  let anyDiff = false;
  DOCUMENTS.forEach((d, i) => {
    if (!perDoc[i]!.inHead) {
      unrecorded.push(d);
      return;
    }
    if (!reported.has(paths[i] as string)) return;
    // git status also reports a file whose size alone changed under core.autocrlf (LF rewritten as CRLF); only a
    // difference git would record, after its own line-ending conversion, counts. A deleted copy always counts.
    if (working[i] != null && !differsFromHead(top, paths[i] as string)) return;
    anyDiff = true;
    const ownLines =
      i === carrier &&
      working[i] != null &&
      perDoc[i]!.workingStatus === 'accepted' &&
      onlyOwnLines(top, paths[i] as string, head[i] as string, working[i] as string);
    if (!ownLines) unrecorded.push(d);
  });
  facts.unrecorded = unrecorded;
  facts.ownLinesOnly = anyDiff && unrecorded.length === 0;
  facts.built = hasHead && isBuilt(input);
  return { row: rowOf(facts), facts };
}

/** The batch form: one entry per folder, in the order given; a folder that cannot be read carries its reason. */
export function fixStates(folders: string[]): FixStateEntry[] {
  return folders.map((folder) => {
    try {
      return { folder, result: fixState(folder) };
    } catch (e) {
      // Whatever stopped this folder is this folder's entry; only wrong arguments fail the batch.
      return { folder, error: e instanceof CouldNotRun ? e.message : `internal error: ${(e as Error).message}` };
    }
  });
}

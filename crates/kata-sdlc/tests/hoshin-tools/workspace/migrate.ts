// Moves one workspace on one machine from the plugin's names before 1.0.0 (ai-sdlc) to hoshin's: the marker
// `.ai-sdlc.json`, the change copies under `<workspace>/.ai-sdlc/copies`, the state folder `ai-sdlc` in each repository's
// git directory, and the workspace instructions block between the `ai-sdlc` markers. Every step is checked before any
// is taken, and every step is idempotent, so a run that stopped midway is finished by running it again.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TRAILER } from '../changes/commit.ts';
import { changeScope, systemScope } from '../changes/scope.ts';
import { CouldNotRun } from '../common/types.ts';
import { commitPaths, currentBranch, git, gitOut, worktrees, type Worktree } from '../git/git.ts';
import { START, END, instructions, markerLines } from './instructions.ts';
import { LEGACY_MARKER, MARKER, markerFileIn, readMarker, type Marker } from './marker.ts';
import { ANY_MARKER, gitDirs, masterFolderName, real, resolveWorkspace, type ResolveOptions } from './resolve.ts';

export type StepStatus = 'done' | 'would' | 'current' | 'manual' | 'refused';
export type MigrateStep = { step: 'marker' | 'copy' | 'state' | 'instructions'; path: string; to: string | null; status: StepStatus; detail: string | null };
export type MigrateResult = {
  workspace: string;
  master: string;
  layout: Marker['layout'];
  write: boolean;
  steps: MigrateStep[];
  kept: string[];
  manual: string[];
  problems: string[];
};

/** A step with what it does once it is allowed to: `act` returns null when it worked, else the reason it did not. */
type Planned = { step: MigrateStep; act: (() => string | null) | null; branch?: string | null };

const OLD_STATE = 'ai-sdlc';
const NEW_STATE = 'hoshin';
const OLD_START = '<!-- ai-sdlc:start -->';
const OLD_END = '<!-- ai-sdlc:end -->';

const step = (kind: MigrateStep['step'], path: string, to: string | null, status: StepStatus, detail: string | null = null): MigrateStep => ({ step: kind, path, to, status, detail });

/** git's message for a failed command, trimmed to what it said. */
const said = (r: { stderr: string; stdout: string }): string => (r.stderr || r.stdout).trim();

const tracked = (dir: string, file: string): boolean => git(dir, ['ls-files', '--error-unmatch', '--', file]).ok;

/** Why the marker cannot be renamed in this checkout, one phrase each; empty when it can. */
function markerRefusals(dir: string): string[] {
  if (existsSync(join(dir, LEGACY_MARKER)) && existsSync(join(dir, MARKER))) return [`both ${LEGACY_MARKER} and ${MARKER} exist`];
  if (tracked(dir, MARKER)) return [`both ${LEGACY_MARKER} and ${MARKER} are tracked`];
  const why: string[] = [];
  if ((gitOut(dir, ['status', '--porcelain', '--', LEGACY_MARKER]) ?? '') !== '') why.push(`${LEGACY_MARKER} has uncommitted changes`);
  if (!git(dir, ['diff', '--cached', '--quiet']).ok) why.push('the index has staged changes');
  const midway = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'].some((name) => existsSync(resolve(dir, gitOut(dir, ['rev-parse', '--git-path', name]) ?? name)));
  if (midway) why.push('a merge or rebase is in progress');
  if (currentBranch(dir) === null) why.push('HEAD is detached');
  return why;
}

/** The scope of the marker commit: a change's own scope in its copy (the change commit rules need it), else the system's, as `commit --kind instructions` takes it. */
function markerScope(dir: string, copyName: string | null): string {
  const systems = Object.keys(readMarker(markerFileIn(dir, ANY_MARKER) as string).systems);
  if (copyName !== null) {
    for (const system of systems) {
      const folder = join(dir, 'intent', system, copyName);
      if (existsSync(folder)) return changeScope(dir, system, folder, ANY_MARKER);
    }
  }
  return systemScope(dir, systems[0] as string, ANY_MARKER);
}

function markerStep(dir: string, branch: string | null, copyName: string | null): Planned {
  const old = join(dir, LEGACY_MARKER);
  const fresh = join(dir, MARKER);
  if (!tracked(dir, LEGACY_MARKER)) return { step: step('marker', fresh, null, 'current', tracked(dir, MARKER) ? null : `${LEGACY_MARKER} is not tracked here, so there is nothing to rename`), act: null };
  const why = markerRefusals(dir);
  if (why.length > 0) return { step: step('marker', old, fresh, 'refused', why.join('; ')), act: null };
  const header = `chore(${markerScope(dir, copyName)}): rename the marker to ${MARKER}`;
  const act = (): string | null => {
    // The file is renamed on disk and both paths are committed, as every other commit of the program takes its paths.
    renameSync(old, fresh);
    const committed = commitPaths(dir, [LEGACY_MARKER, MARKER], [header, TRAILER]);
    if (committed.ok) return null;
    git(dir, ['reset', '--quiet', '--', LEGACY_MARKER, MARKER]);
    renameSync(fresh, old);
    return committed.error;
  };
  return { step: step('marker', old, fresh, 'would'), act, branch };
}

/** The renames of one git directory's `ai-sdlc` folder to `hoshin`. */
function stateStep(gitDir: string): Planned {
  const old = join(gitDir, OLD_STATE);
  const fresh = join(gitDir, NEW_STATE);
  if (!existsSync(old)) return { step: step('state', fresh, null, 'current'), act: null };
  if (existsSync(fresh)) return { step: step('state', old, fresh, 'refused', `both ${OLD_STATE} and ${NEW_STATE} exist in ${gitDir}`), act: null };
  const act = (): string | null => {
    // A file held open in the folder (an editor, a running build) makes the rename fail; the step is then refused and a rerun takes it.
    try {
      renameSync(old, fresh);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  return { step: step('state', old, fresh, 'would'), act };
}

/** The git directories whose state moves: the repository's shared one, and each linked worktree's own that holds state (an active build's file lives there). */
function stateFolders(repository: string): string[] {
  const common = (gitDirs(repository) as { common: string }).common;
  const linked = join(common, 'worktrees');
  const own = existsSync(linked) ? readdirSync(linked).map((id) => join(linked, id)) : [];
  return [common, ...own.filter((dir) => existsSync(join(dir, OLD_STATE)) || existsSync(join(dir, NEW_STATE)))];
}

/** What the instructions block's old markers say about the file: no block, a malformed one, a clash with the new block, or an old block to replace. */
function oldBlock(text: string): 'none' | 'bad' | 'both' | 'block' {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const starts = lines.flatMap((l, i) => (l === OLD_START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === OLD_END ? [i] : []));
  if (starts.length === 0 && ends.length === 0) return 'none';
  if (markerLines(text).length > 0) return 'both';
  return starts.length === 1 && ends.length === 1 && (starts[0] as number) < (ends[0] as number) ? 'block' : 'bad';
}

const RERUN_SETUP = 'run the hoshin setup skill with `--instructions` to write the new block, then delete the old block between the `ai-sdlc` markers';

function instructionsStep(workspace: string, main: string, marker: Marker, master: string): Planned {
  const single = marker.layout === 'single-repo';
  const file = join(single ? main : workspace, 'CLAUDE.md');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kind = oldBlock(text);
  if (kind === 'none') return { step: step('instructions', file, null, 'current'), act: null };
  if (kind === 'both') return { step: step('instructions', file, null, 'refused', `${file} holds a block between the ai-sdlc markers and one between the hoshin markers`), act: null };
  if (kind === 'bad') return { step: step('instructions', file, null, 'refused', `${file} has an ai-sdlc start marker without its end marker, or the markers are not each there once, start first`), act: null };

  const input = { workspace, master: main, masterName: masterFolderName(workspace, master, ANY_MARKER), marker, allowHome: false };
  const check = instructions({ ...input, write: false });
  if (check.workspaceMd !== 'current' || check.claudeMd === 'home-folder') {
    const why = check.claudeMd === 'home-folder' ? 'the workspace is the home folder' : `${join(main, 'intent', 'workspace.md')} is ${check.workspaceMd}`;
    return { step: step('instructions', file, null, 'manual', `${why}, so the block was left as it is; ${RERUN_SETUP}`), act: null };
  }
  const act = (): string | null => {
    // The old markers become the new ones where they stand, so the block keeps its place; the writer then replaces what is between them.
    writeFileSync(file, text.split(/(?<=\n)/).map((l) => (l.trim() === OLD_START ? l.replace(OLD_START, START) : l.trim() === OLD_END ? l.replace(OLD_END, END) : l)).join(''));
    const result = instructions({ ...input, write: true });
    if (result.problems.length === 0) return null;
    writeFileSync(file, text);
    return result.problems.join(' ');
  };
  return { step: step('instructions', file, null, 'would'), act };
}

/** The entries left in the old copies folder, and in the old folder beside it, once `moving` has gone. */
function keptEntries(workspace: string, moving: string[]): string[] {
  const root = join(workspace, '.ai-sdlc');
  const copies = join(root, 'copies');
  const entries = (folder: string, not: string[]): string[] => (existsSync(folder) ? readdirSync(folder).filter((n) => !not.includes(n)).map((n) => join(folder, n)) : []);
  return [...entries(copies, moving), ...entries(root, ['copies'])];
}

/** Removes the old copies folder and the old folder above it, each only when empty. */
function removeEmptyOldFolders(workspace: string): void {
  for (const folder of [join(workspace, '.ai-sdlc', 'copies'), join(workspace, '.ai-sdlc')]) {
    if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  }
}

/** Plans every step for the workspace `resolved` names, in the order they are taken. */
function plan(workspace: string, master: string, main: string, marker: Marker): { groups: Planned[][]; moving: string[] } {
  const oldCopies = join(workspace, '.ai-sdlc', 'copies');
  const newCopies = join(workspace, '.hoshin', 'copies');
  const checkouts = worktrees(main).map((w): Worktree => ({ ...w, path: real(w.path) })).filter((w) => !w.prunable && existsSync(w.path));
  const isCopy = (w: Worktree): boolean => [oldCopies, newCopies].some((c) => dirname(w.path) === real(c));

  const markers = checkouts.map((w) => markerStep(w.path, w.branch, isCopy(w) ? basename(w.path) : null));
  const moving = checkouts.filter((w) => dirname(w.path) === real(oldCopies));
  const copies = moving.map((w): Planned => {
    const to = join(newCopies, basename(w.path));
    if (existsSync(to)) return { step: step('copy', w.path, to, 'refused', `${to} already exists`), act: null };
    const act = (): string | null => {
      mkdirSync(newCopies, { recursive: true });
      const moved = git(main, ['worktree', 'move', w.path, to]);
      return moved.ok ? null : said(moved);
    };
    return { step: step('copy', w.path, to, 'would'), act };
  });

  const repositories = [main];
  if (marker.layout === 'workspace') {
    for (const { repos } of Object.values(marker.systems)) {
      for (const name of repos) {
        const path = join(workspace, name);
        if (existsSync(join(path, '.git'))) repositories.push(path);
      }
    }
  }
  const seen = new Set<string>();
  const stateSteps = repositories.flatMap(stateFolders).filter((dir) => !seen.has(dir) && seen.add(dir)).map(stateStep);
  const instructionStep = instructionsStep(workspace, main, marker, master);
  return { groups: [markers, copies, stateSteps, [instructionStep]], moving: moving.map((w) => basename(w.path)) };
}

export function migrate(cwd: string, options: ResolveOptions, write: boolean): MigrateResult {
  const resolved = resolveWorkspace(cwd, options, ANY_MARKER);
  if (resolved.master === null || resolved.workspace === null) throw new CouldNotRun(resolved.problems.join('\n') || 'no master repository');
  const { master, workspace, layout } = resolved;
  const first = worktrees(master)[0];
  if (first === undefined) throw new CouldNotRun(`${master} has no checkout`);
  const main = real(first.path);
  const marker = readMarker(markerFileIn(main, ANY_MARKER) ?? (markerFileIn(master, ANY_MARKER) as string));

  const { groups, moving } = plan(workspace, master, main, marker);
  const planned = groups.flat();
  const problems = planned.filter((p) => p.step.status === 'refused').map((p) => `${p.step.step} ${p.step.path}: ${p.step.detail}`);
  const steps: MigrateStep[] = [];
  let kept = keptEntries(workspace, moving);

  if (problems.length > 0 || !write) {
    steps.push(...planned.map((p) => p.step));
  } else {
    let failed = false;
    for (const [index, group] of groups.entries()) {
      for (const p of group) {
        if (p.act === null) {
          steps.push(p.step);
          continue;
        }
        const error = p.act();
        if (error === null) {
          steps.push({ ...p.step, status: 'done' });
          continue;
        }
        steps.push({ ...p.step, status: 'refused', detail: error });
        problems.push(`${p.step.step} ${p.step.path}: ${error}`);
        failed = true;
        break;
      }
      if (failed) break;
      if (index === 1) removeEmptyOldFolders(workspace);
    }
    kept = keptEntries(workspace, []);
  }

  const pushed = [...new Set(planned.filter((p) => p.act !== null && p.branch).map((p) => p.branch as string))];
  const manual = [
    pushed.length > 0
      ? `push the marker commit on ${pushed.join(', ')}`
      : 'push any marker commit not yet pushed; this run made none',
    'install the hoshin plugin (`hoshin@hoshin`) and uninstall the ai-sdlc plugin (`ai-sdlc@ai-sdlc`)',
    ...steps.filter((s) => s.step === 'instructions' && s.status === 'manual').map((s) => `instructions: ${s.detail}`),
    ...(layout === 'single-repo' && steps.some((s) => s.step === 'instructions' && (s.status === 'done' || s.status === 'would')) ? ['commit CLAUDE.md, which now holds the new block: `commit --kind instructions -- CLAUDE.md`'] : []),
  ];
  return { workspace, master, layout, write, steps, kept, manual, problems };
}

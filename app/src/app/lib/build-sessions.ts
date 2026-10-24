import type { BuildStatus } from '@bindings/BuildStatus';
import type { RunLink } from '@bindings/RunLink';
import type { RunRecord } from '@bindings/RunRecord';
import type { TaskLink } from '@bindings/TaskLink';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { BuildStage } from './build-stage';
import { STATUS_LABEL, statusForExit, type RunState, type RunSummary } from './events';

export type Pick = { kind: 'repo'; repo: string } | { kind: 'task'; task: string } | { kind: 'review' };
export type SessionRef = { runId: string; startedAt: number };
type Summary = { exit_code: RunSummary['exit_code']; num_turns: RunSummary['num_turns']; cost_usd?: RunSummary['cost_usd'] };

/** A run's one line: its status, then exit, turns and cost once it completed. Live and recorded runs share these words. */
export const outcomeOf = (state: RunState, summary: Summary | null): string => {
  if (summary === null) return STATUS_LABEL[state];
  const cost = summary.cost_usd == null ? '' : ` · $${summary.cost_usd.toFixed(2)}`;
  return `${STATUS_LABEL[state]} · exit ${summary.exit_code} · ${summary.num_turns} turns${cost}`;
};

const REVIEW = 'review';
const BUILD = 'build:';

/** This change's build and review run links, keyed by repository (or `review`), each list oldest first. */
export const repoSessions = (
  links: RunLink[],
  scope: { workspaceId: string; system: string; change: string },
): Map<string, RunLink[]> => {
  const out = new Map<string, RunLink[]>();
  for (const l of links) {
    if (l.workspace_id !== scope.workspaceId || l.system !== scope.system || l.change !== scope.change) continue;
    const key = l.stage === REVIEW ? REVIEW : l.stage.startsWith(BUILD) ? l.stage.slice(BUILD.length) : null;
    if (key === null) continue;
    out.set(key, [...(out.get(key) ?? []), l]);
  }
  for (const list of out.values()) list.sort((a, b) => a.started_at - b.started_at);
  return out;
};

/** The ids of the repository's tasks that have a row in `after` and none in `before`, in plan order. */
export const newlyRecorded = (before: BuildStatus, after: BuildStatus, repo: string): string[] => {
  const had = new Set(before.tasks.filter((t) => t.row !== null).map((t) => t.id));
  return after.tasks.filter((t) => t.repo === repo && t.row !== null && !had.has(t.id)).map((t) => t.id);
};

/** An earlier run's one line from its record. A record with no exit code never reached a terminal event, which reads as an error. */
export const recordOutcome = (record: RunRecord | null): string => {
  if (record === null) return 'Outcome not recorded';
  if (record.exit == null) return STATUS_LABEL[statusForExit(null)];
  return outcomeOf(statusForExit(record.exit), { exit_code: record.exit, num_turns: record.turns ?? 0, cost_usd: record.cost_usd });
};

/**
 * The sessions a pick shows, and whether the build cannot tell which session built a picked task.
 * Of several links naming a task, the one whose run started last among the repository's sessions counts;
 * a link whose run is not among them cannot be ordered and is ignored.
 */
export const sessionsFor = (
  pick: Pick,
  tasks: TaskStatus[],
  sessions: Map<string, SessionRef[]>,
  taskLinks: TaskLink[],
): { sessions: SessionRef[]; unknown: boolean } => {
  if (pick.kind === 'review') return { sessions: sessions.get(REVIEW) ?? [], unknown: false };
  if (pick.kind === 'repo') return { sessions: sessions.get(pick.repo) ?? [], unknown: false };
  const task = tasks.find((t) => t.id === pick.task);
  if (task === undefined) return { sessions: [], unknown: true };
  const all = sessions.get(task.repo) ?? [];
  if (task.row === null) return { sessions: all, unknown: false };
  const linked = taskLinks
    .filter((l) => l.task === task.id && l.repo === task.repo)
    .map((l) => all.find((s) => s.runId === l.run_id))
    .filter((s): s is SessionRef => s !== undefined);
  if (linked.length === 0) return { sessions: all, unknown: true };
  return { sessions: [linked.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))], unknown: false };
};

/** What the engineer picked, and the stage the build was at when they did; a Go to also carries its focus request. */
export type Chosen = { pick: Pick; stage: BuildStage; /** Counts the engineer's picks, so picking the same thing again is a new pick. */ seq: number; goTo: { repo: string; n: number } | null };

/** A run of a repository that is live now, with the build log as it stood before the run started. */
export type LiveRun = { runId: string; repo: string; before: BuildStatus };

export type ActivityInput = {
  stage: BuildStage;
  chosen: Chosen | null;
  /** The first repository of the tasks area, or null when there is none. */
  firstRepo: string | null;
  /** The build log as it stands now; null before it was read. */
  status: BuildStatus | null;
  live: LiveRun[];
  taskLinks: TaskLink[];
  scope: { workspaceId: string; system: string; change: string } | null;
};

export type Activity = {
  /** What the activity area shows; null before the build log was read. */
  pick: Pick | null;
  /** Which of the engineer's picks this is; 0 for the default. */
  seq: number;
  /** A request to bring the picked repository's open question into view; set only by a Go to the pick still stands on. */
  focus: { repo: string; n: number } | null;
  /** The task links including those of tasks a live run just recorded, which are not persisted yet. */
  taskLinks: TaskLink[];
  /** The links of tasks a live run recorded that no link names yet, to persist. */
  newLinks: TaskLink[];
};

const AT_REVIEW: readonly BuildStage[] = ['reviewing', 'review-finished', 'done'];

/**
 * Decides what the pick is and what the activity area shows for it.
 * The default pick is the first repository, and the review once the build reached it: its live session at reviewing, its
 * findings after. A pick made at an earlier stage does not outlive the move to the review, so an old pick or Go to never hides it.
 * A Go to is a pick that also asks for its question to be brought into view; it stands exactly as long as the pick does.
 * A task whose build log row appeared while its repository's run is live is linked to that run now, not when the run ends.
 */
export const activityFor = (input: ActivityInput): Activity => {
  const { stage, status, scope } = input;
  const chosen = input.chosen !== null && AT_REVIEW.includes(stage) && input.chosen.stage !== stage ? null : input.chosen;
  const pick: Pick | null =
    status === null
      ? null
      : chosen !== null
        ? chosen.pick
        : AT_REVIEW.includes(stage) || input.firstRepo === null
          ? { kind: 'review' }
          : { kind: 'repo', repo: input.firstRepo };
  const newLinks: TaskLink[] =
    status === null || scope === null
      ? []
      : input.live.flatMap((run) =>
          newlyRecorded(run.before, status, run.repo)
            .filter((task) => !input.taskLinks.some((l) => l.repo === run.repo && l.task === task && l.run_id === run.runId))
            .map((task) => ({ workspace_id: scope.workspaceId, system: scope.system, change: scope.change, repo: run.repo, task, run_id: run.runId })),
        );
  return { pick, seq: chosen?.seq ?? 0, focus: status === null ? null : (chosen?.goTo ?? null), taskLinks: newLinks.length === 0 ? input.taskLinks : [...input.taskLinks, ...newLinks], newLinks };
};

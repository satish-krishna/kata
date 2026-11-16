// Which repository of a change can be built now, which waits and on what, and whether the review is next. The build
// skill and a tool that drives the build both read this, so neither works the order out itself. GRAMMAR.md ("The
// schedule") has the rules.

export type ScheduledRepo = {
  repo: string;
  state: 'ready' | 'waiting' | 'done';
  /** The repository's first task without a build log entry; null when it is done. */
  task: string | null;
  waitingOn: { task: string; repo: string }[];
};

export type Schedule = { repos: ScheduledRepo[]; next: 'build' | 'review' | 'blocked'; oneAtATime: boolean };

type PlannedTask = { id: string; repo: string; depends_on: string[] };

/** The schedule of a plan's tasks, in document order, given the tasks that have a build log entry. */
export function scheduleOf(tasks: PlannedTask[], logged: Set<string>, oneAtATime: boolean): Schedule {
  const repoOf = new Map(tasks.map((t) => [t.id, t.repo]));
  const repos = [...new Set(tasks.map((t) => t.repo))].map((repo): ScheduledRepo => {
    const first = tasks.find((t) => t.repo === repo && !logged.has(t.id));
    if (first === undefined) return { repo, state: 'done', task: null, waitingOn: [] };
    // A task of the same repository is built before this one in any case, and a task the plan does not have never is.
    const waitingOn = [...new Set(first.depends_on)]
      .filter((id) => !logged.has(id) && repoOf.has(id) && repoOf.get(id) !== repo)
      .map((id) => ({ task: id, repo: repoOf.get(id) as string }));
    return { repo, state: waitingOn.length > 0 ? 'waiting' : 'ready', task: first.id, waitingOn };
  });
  const next = repos.some((r) => r.state === 'ready') ? 'build' : repos.every((r) => r.state === 'done') ? 'review' : 'blocked';
  return { repos, next, oneAtATime };
}

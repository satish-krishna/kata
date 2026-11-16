// How far a change's build has got: the plan's tasks per repository, and which of them have a build log entry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedBuildLog, ParsedPlan } from '../common/types.ts';
import { readBuildLog } from '../documents/build-log.ts';
import { readPlan } from '../documents/plan.ts';
import { findMarker } from '../workspace/marker.ts';

/** The plan's tasks, or null when the change has no plan that reads cleanly. */
export function planTasks(folder: string): ParsedPlan['tasks'] | null {
  const file = join(folder, 'plan.md');
  if (!existsSync(file)) return null;
  return tasksOf(readFileSync(file, 'utf8'), file);
}

/** The tasks of a plan's text (the working copy or one committed), or null when it does not read cleanly. */
export function tasksOf(text: string, file: string): ParsedPlan['tasks'] | null {
  const result = readPlan(text, file, findMarker(file));
  return result.kind === 'plan' && result.problems.length === 0 ? result.document.tasks : null;
}

/** The tasks with an entry in a repository's build log. */
export function loggedTasks(folder: string, repo: string): Set<string> {
  const file = join(folder, 'build', `${repo}.md`);
  if (!existsSync(file)) return new Set();
  return entriesOf(readFileSync(file, 'utf8'), file);
}

/** The tasks with an entry in a build log's text (the working copy or one committed). */
export function entriesOf(text: string, file: string): Set<string> {
  const result = readBuildLog(text, file);
  return new Set(result.kind === 'build-log' ? (result.document as ParsedBuildLog).entries.map((e) => e.task) : []);
}

/** The repositories the plan names, in the order they first appear. */
export function planRepos(folder: string): string[] {
  return [...new Set((planTasks(folder) ?? []).map((t) => t.repo))];
}

/** The plan's tasks for a repository that have no build log entry yet; null when there is no readable plan. */
export function unloggedTasks(folder: string, repo: string): string[] | null {
  const tasks = planTasks(folder);
  if (tasks === null) return null;
  const logged = loggedTasks(folder, repo);
  return tasks.filter((t) => t.repo === repo && !logged.has(t.id)).map((t) => t.id);
}

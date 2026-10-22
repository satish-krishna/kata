import type { BuildRow } from '@bindings/BuildRow';
import type { ParsedSection } from '@bindings/ParsedSection';
import type { ParsedTask } from '@bindings/ParsedTask';
import type { TaskStatus } from '@bindings/TaskStatus';

/* What the plan's task detail shows beyond the task's own sections: the tasks that need it and what the build log
 * says about it. Everything here works on tasks the format program already read; nothing reads plan text. */

/** A task of the plan with the build log row that records it, if any. */
export type TaskView = ParsedTask & { row: BuildRow | null };

/** The plan's tasks, each with the row the build status holds for it. A task the status does not list has no row. */
export function withRows(plan: readonly ParsedTask[], status: readonly TaskStatus[]): TaskView[] {
  const rows = new Map(status.map((t) => [t.id, t.row]));
  return plan.map((t) => ({ ...t, row: rows.get(t.id) ?? null }));
}

/** The sections the task detail shows: all but Depends on, which the muted line above the task name already says. */
export function shownSections(task: ParsedTask): ParsedSection[] {
  return task.sections.filter((s) => s.title !== 'Depends on');
}

/** The tasks whose `Depends on` names `id`, in plan order. */
export function neededBy(tasks: readonly ParsedTask[], id: string): string[] {
  return tasks.filter((t) => t.depends_on.includes(id)).map((t) => t.id);
}

export type TaskRecord = { kind: 'planned' | 'differs' | 'unbuilt'; label: string; text: string | null };

/** What a task's build log row says: not built, built as planned, or built with a departure written out. */
export function taskRecord(task: { row: BuildRow | null }): TaskRecord {
  if (task.row === null) return { kind: 'unbuilt', label: 'Not built yet', text: null };
  if (task.row.departure === null) return { kind: 'planned', label: 'As planned', text: null };
  return { kind: 'differs', label: 'Differs from plan', text: task.row.departure };
}

const REQUIREMENT_ID = /(?<![\w.])R\d+(?:\.\d+)?(?![\w]|\.\d)/g;

/**
 * Turns each requirement or scenario id (`R7`, `R7.7`) outside code into a link to `#req-<id>`, which the task detail
 * catches to open that requirement on the Spec tab.
 */
export function linkRequirements(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(REQUIREMENT_ID, (id) => `[${id}](#req-${id})`))).join('');
}

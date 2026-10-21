import type { TaskStatus } from '@bindings/TaskStatus';

/* What the plan's task detail shows beyond the task's own text: its labeled fields, the tasks that need it and what
 * the build log says about it. */

export type TaskField = { field: string; body: string };

const FIELD = /^- \*\*(.+?):\*\*\s*(.*)$/;

/**
 * The `- **<Field>:** ...` bullets of a task's text, in order. A field's body is the rest of its line and the lines
 * below it up to the next field, dedented by the two spaces of a nested bullet.
 */
export function taskFields(text: string): TaskField[] {
  const out: { field: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = FIELD.exec(line);
    if (m) out.push({ field: m[1], lines: [m[2]] });
    else out.at(-1)?.lines.push(line.replace(/^ {1,2}/, ''));
  }
  return out.map((f) => ({ field: f.field, body: f.lines.join('\n').trim() }));
}

/** The tasks whose `Depends on` names `id`, in plan order. */
export function neededBy(tasks: readonly TaskStatus[], id: string): string[] {
  return tasks.filter((t) => t.dependsOn.includes(id)).map((t) => t.id);
}

export type TaskRecord = { kind: 'planned' | 'differs' | 'unbuilt'; label: string; text: string | null };

/** What a task's build log row says: not built, built as planned, or built with a departure written out. */
export function taskRecord(task: TaskStatus): TaskRecord {
  if (task.row === null) return { kind: 'unbuilt', label: 'Not built yet', text: null };
  if (task.row.departure === null) return { kind: 'planned', label: 'As planned', text: null };
  return { kind: 'differs', label: 'Differs from plan', text: task.row.departure };
}

/** A task's own text without its `### T<n>: ...` heading line: what to show for a task that has no field bullets. */
export function taskBody(text: string): string {
  return text.replace(/^[^\n]*(?:\n|$)/, '').trim();
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

// Checks the documents of one change against each other: every scenario covered by a task, every task's references
// in the spec, every build log entry naming a task of the plan.
import { readFileSync } from 'node:fs';
import { parseFrontMatter } from '../documents/front-matter.ts';
import type { Marker } from '../workspace/marker.ts';
import type { ParsedBuildLog, ParsedPlan, ParsedSpec, ParsedTask, Problem, ReadResult } from '../common/types.ts';

/** A document of one change, as read: the file it came from and what the reader made of it. */
export type ChangeDoc = { file: string; result: ReadResult };

/** The 1-based line of a task's `key:` field, or of its heading when the field is not written. */
function fieldLine(task: ParsedTask, key: string): number {
  const re = new RegExp(`^${key}\\s*:`);
  const at = task.text.split('\n').findIndex((l) => re.test(l));
  return at < 0 ? task.line : task.line + at;
}

/** Every ID the spec holds, rules and scenarios, whatever layout the spec is in. */
function specIds(spec: ParsedSpec): Set<string> {
  const ids = new Set<string>();
  for (const r of spec.requirements) {
    ids.add(r.id);
    for (const s of r.scenarios) ids.add(s.id);
  }
  return ids;
}

/** The problems of a layout 2 plan with itself and with the spec: dependencies, task IDs, covers, uses. */
function checkPlan(plan: ParsedPlan, planFile: string, spec: { doc: ParsedSpec; file: string } | null): Problem[] {
  const problems: Problem[] = [];
  const add = (line: number, message: string): void => {
    problems.push({ file: planFile, line, message });
  };
  const position = new Map<string, number>();
  plan.tasks.forEach((t, i) => {
    if (position.has(t.id)) add(t.line, `task ID ${t.id} is used twice`);
    else position.set(t.id, i);
  });
  const owners = new Map(plan.shared_decisions.map((d) => [d.question, d.owner]));
  const ids = spec === null ? null : specIds(spec.doc);
  const covered = new Set<string>();

  plan.tasks.forEach((t, i) => {
    for (const dep of t.depends_on) {
      const at = position.get(dep);
      if (at === undefined) add(fieldLine(t, 'depends_on'), `${t.id} depends on ${dep}, which is not in the plan`);
      else if (at > i) add(fieldLine(t, 'depends_on'), `${t.id} depends on ${dep}, which comes after it`);
    }
    for (const id of [...t.covers, ...t.supports]) {
      if (ids !== null && !ids.has(id)) {
        const key = t.covers.includes(id) ? 'covers' : 'supports';
        add(fieldLine(t, key), `${t.id} ${key} ${id}, which is not in the spec`);
      }
    }
    for (const id of t.covers) covered.add(id);
    for (const question of t.uses) {
      const owner = owners.get(question);
      if (owner === undefined) add(fieldLine(t, 'uses'), `${t.id} uses "${question}", which no shared decision owns`);
      else if (!t.depends_on.includes(owner) && owner !== t.id) {
        add(fieldLine(t, 'uses'), `${t.id} uses "${question}" but does not depend on ${owner}`);
      }
    }
  });

  if (spec !== null) {
    for (const r of spec.doc.requirements) {
      for (const s of r.scenarios) {
        // A task that covers a whole rule covers each scenario under it.
        if (!covered.has(s.id) && !covered.has(r.id)) {
          problems.push({ file: spec.file, line: s.line, message: `scenario ${s.id} is covered by no task` });
        }
      }
    }
  }
  return problems;
}

/** The problems of one build log against the plan's tasks. */
function checkLog(log: ParsedBuildLog, logFile: string, plan: ParsedPlan): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map<string, ParsedTask>();
  for (const t of plan.tasks) if (!byId.has(t.id)) byId.set(t.id, t);
  for (const e of log.entries) {
    const task = byId.get(e.task);
    if (task === undefined) {
      problems.push({ file: logFile, line: e.line, message: `build log entry ${e.task} is not a task in the plan` });
    } else if (task.repo !== '' && log.repo !== '' && task.repo !== log.repo) {
      problems.push({ file: logFile, line: e.line, message: `build log entry ${e.task} belongs to repository ${task.repo}` });
    }
  }
  return problems;
}

/** Whether the plan file's front matter says `status: superseded`: a reopened intent or spec left it behind. */
function superseded(file: string): boolean {
  try {
    return String(parseFrontMatter(readFileSync(file, 'utf8'), file).data.status ?? '') === 'superseded';
  } catch {
    return false;
  }
}

/**
 * Checks the documents of one change against each other: the plan's references to its own tasks and to the spec,
 * and each build log's entries against the plan. The plan's own references are checked only when the plan is in
 * layout 2 (a layout 1 plan keeps them in prose, and the old build already accepted those plans); build log entries
 * are checked against the plan's tasks whatever the layouts, and the spec's IDs are read in whatever layout the
 * spec has. A superseded plan is not checked against the spec, neither its references to it nor its coverage of it:
 * reopening the spec (which marks the plan superseded) may add scenarios no plan covers yet, and the spec must still
 * be accepted before the plan is rewritten. Its own references and the build logs against it are still checked.
 * `marker` is accepted so callers pass what they found; the references checked here need nothing from it.
 */
export function checkChange(docs: ChangeDoc[], _marker: Marker | null): Problem[] {
  let spec: { doc: ParsedSpec; file: string } | null = null;
  let plan: { doc: ParsedPlan; file: string; layout: number } | null = null;
  const logs: { doc: ParsedBuildLog; file: string }[] = [];
  for (const { file, result } of docs) {
    if (result.kind === 'spec') spec = { doc: result.document, file };
    else if (result.kind === 'plan') plan = { doc: result.document, file, layout: result.layout };
    else if (result.kind === 'build-log') logs.push({ doc: result.document, file });
  }
  const problems: Problem[] = [];
  if (plan === null) return problems;
  if (plan.layout >= 2) problems.push(...checkPlan(plan.doc, plan.file, superseded(plan.file) ? null : spec));
  for (const log of logs) problems.push(...checkLog(log.doc, log.file, plan.doc));
  return problems;
}

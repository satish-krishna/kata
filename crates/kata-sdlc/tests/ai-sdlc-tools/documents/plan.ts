// Reads a plan, `plan.md`: its tasks and shared decisions. Layout in GRAMMAR.md.
import Ajv from '../vendor/ajv.mjs';
import { keyLine, nextHeading, recordPrefix, reportUnread, schemaMessages, splitDoc, strings, yamlBlock, type Block, type Doc } from './doc.ts';
import { parse } from '../vendor/yaml.mjs';
import sharedDecisionSchema from '../schema/shared-decision.schema.json' with { type: 'json' };
import planTaskSchema from '../schema/plan-task.schema.json' with { type: 'json' };
import { layoutOf, parseFrontMatter, refuseNewerLayout } from './front-matter.ts';
import type { Marker } from '../workspace/marker.ts';
import type { ParsedSharedDecision, ParsedTask, Problem, ReadResult } from '../common/types.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateTask = ajv.compile(planTaskSchema);
const validateDecision = ajv.compile(sharedDecisionSchema);

const HEADING1 = /^### (T\d+): (.*?)\s+\(`([\p{L}\p{N}_.-]+)`\)\s*$/u;
const HEADING2 = /^### (T\d+):\s*(.*?)\s*$/;
const ANY_HEADING = /^#{1,3} /;

type Head = { index: number; id: string; name: string; repo: string };

function taskHeads(doc: Doc, layout2: boolean): Head[] {
  const heads: Head[] = [];
  doc.lines.forEach((line, index) => {
    if (!doc.heading[index]) return;
    if (layout2) {
      const m = HEADING2.exec(line);
      if (m) heads.push({ index, id: m[1] as string, name: m[2] as string, repo: '' });
    } else {
      const m = HEADING1.exec(line);
      if (m) heads.push({ index, id: m[1] as string, name: m[2] as string, repo: m[3] as string });
    }
  });
  return heads;
}

function dependencyIds(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter((w) => /^T\d+$/.test(w));
}

const FIELD = /^- \*\*(.+?):\*\*\s*(.*)$/;

/** Layout 1: the `- **<Field>:**` bullets of a task as sections; prose before the first bullet has an empty title. */
function bulletSections(lines: string[]): { title: string; body: string }[] {
  const out: { title: string; lines: string[] }[] = [{ title: '', lines: [] }];
  for (const line of lines) {
    const m = FIELD.exec(line);
    if (m) out.push({ title: m[1] as string, lines: [m[2] as string] });
    else (out.at(-1) as { lines: string[] }).lines.push(out.length > 1 ? line.replace(/^ {1,2}/, '') : line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() })).filter((s) => s.title !== '' || s.body !== '');
}

/** Layout 2: the `####` sections of a task. */
function headingSections(doc: Doc, from: number, end: number): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  let i = nextHeading(doc, from, end, /^#### /);
  while (i < end) {
    const next = nextHeading(doc, i + 1, end, /^#### /);
    out.push({
      title: (doc.lines[i] as string).replace(/^#### /, '').trim(),
      body: doc.lines.slice(i + 1, next).join('\n').trim(),
    });
    i = next;
  }
  return out;
}

function readTasks2(
  doc: Doc,
  heads: Head[],
  file: string,
  problems: Problem[],
  repos: string[] | null,
  system: string,
  claimed: Set<number>,
): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  heads.forEach((h, n) => {
    const limit = heads[n + 1]?.index ?? doc.lines.length;
    const end = nextHeading(doc, h.index + 1, limit, ANY_HEADING);
    const line = h.index + 1;
    const problem = (at: number, message: string): void => {
      problems.push({ file, line: at, message });
    };
    const task: ParsedTask = {
      id: h.id,
      name: h.name,
      repo: '',
      depends_on: [],
      uses: [],
      files: [],
      covers: [],
      supports: [],
      sections: headingSections(doc, h.index + 1, end),
      text: doc.lines.slice(h.index, end).join('\n').trimEnd(),
      line,
    };
    tasks.push(task);
    const block = yamlBlock(doc, h.index + 1, nextHeading(doc, h.index + 1, end, /^#### /));
    if (!block) {
      problem(line, `task ${h.id} has no fields block`);
    } else {
      claimed.add(block.open);
      let fields: unknown;
      let parsed = true;
      try {
        fields = parse(block.text);
      } catch (e) {
        parsed = false;
        problem(block.open + 1, `task ${h.id} fields are not valid YAML: ${(e as Error).message.split('\n')[0]}`);
      }
      if (parsed) {
        if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
          problem(block.open + 1, `task ${h.id} fields are not a set of fields`);
        } else {
          const f = fields as Record<string, unknown>;
          if (!validateTask(f)) {
            for (const m of schemaMessages(validateTask.errors, `task ${h.id} fields`, true)) problem(block.open + 1, m);
          }
          if (typeof f['id'] === 'string' && f['id'] !== h.id) {
            problem(keyLine(doc, block, 'id'), `heading says ${h.id}, fields say ${f['id']}`);
          }
          if (typeof f['repo'] === 'string') {
            task.repo = f['repo'];
            if (repos !== null && !repos.includes(f['repo'])) {
              problem(keyLine(doc, block, 'repo'), `task ${h.id} names repository ${f['repo']}, not in system ${system}`);
            }
          }
          task.depends_on = strings(f['depends_on']);
          task.uses = strings(f['uses']);
          task.files = strings(f['files']);
          task.covers = strings(f['covers']);
          task.supports = strings(f['supports']);
        }
      }
    }
    if (!task.sections.some((s) => s.title.toLowerCase() === 'tests')) problem(line, `task ${h.id} has no Tests section`);
  });
  return tasks;
}

function readTasks1(doc: Doc, heads: Head[]): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  heads.forEach((h, n) => {
    const limit = heads[n + 1]?.index ?? doc.lines.length;
    const end = nextHeading(doc, h.index + 1, limit, ANY_HEADING);
    const body = doc.lines.slice(h.index + 1, end);
    const depends = body.find((l) => l.trimStart().startsWith('- **Depends on:**'));
    tasks.push({
      id: h.id,
      name: h.name,
      repo: h.repo,
      depends_on:
        depends === undefined ? tasks.map((t) => t.id) : dependencyIds(depends.trimStart().slice('- **Depends on:**'.length)),
      // Layout 1 holds these as prose; they stay readable as sections.
      uses: [],
      files: [],
      covers: [],
      supports: [],
      sections: bulletSections(body),
      text: doc.lines.slice(h.index, end).join('\n').trimEnd(),
      line: h.index + 1,
    });
  });
  return tasks;
}

/** Splits a table row on its unescaped pipes. */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells: string[] = [];
  let cur = '';
  for (let i = 1; i < t.length; i++) {
    const c = t[i] as string;
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') cells.push(cur.trim());
  return cells;
}

function sharedSection(doc: Doc): { heading: number; end: number } | null {
  const heading = nextHeading(doc, 0, doc.lines.length, /^## Shared decisions\s*$/i);
  if (heading >= doc.lines.length) return null;
  return { heading, end: nextHeading(doc, heading + 1, doc.lines.length, /^#{1,2} /) };
}

function decisions1(doc: Doc): ParsedSharedDecision[] {
  const section = sharedSection(doc);
  if (!section) return [];
  const out: ParsedSharedDecision[] = [];
  for (let i = section.heading + 1; i < section.end; i++) {
    const cells = tableCells(doc.lines[i] as string);
    if (!cells || cells.length < 3) continue;
    const [question, owner, fn] = cells as [string, string, string];
    if (/^:?-+:?$/.test(question) || question.toLowerCase() === 'question' || question.startsWith('<')) continue;
    out.push({ question, owner, function: fn });
  }
  return out;
}

function decisions2(doc: Doc, file: string, problems: Problem[], claimed: Set<number>): ParsedSharedDecision[] {
  const section = sharedSection(doc);
  if (!section) return [];
  const problem = (line: number, message: string): void => {
    problems.push({ file, line, message });
  };
  const block = yamlBlock(doc, section.heading + 1, section.end);
  if (!block) {
    problem(section.heading + 1, 'shared decisions are not a yaml list');
    return [];
  }
  claimed.add(block.open);
  let list: unknown;
  try {
    list = parse(block.text);
  } catch (e) {
    problem(block.open + 1, `shared decisions are not valid YAML: ${(e as Error).message.split('\n')[0]}`);
    return [];
  }
  if (list === null || list === undefined) list = [];
  if (!Array.isArray(list)) {
    problem(block.open + 1, 'shared decisions are not a list');
    return [];
  }
  const out: ParsedSharedDecision[] = [];
  list.forEach((entry: unknown, i: number) => {
    const who = `shared decision ${i + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problem(block.open + 1, `${who} is not a set of fields`);
    } else if (!validateDecision(entry)) {
      for (const m of schemaMessages(validateDecision.errors, who, false)) problem(block.open + 1, m);
    } else {
      const e = entry as ParsedSharedDecision;
      out.push({ question: e.question, owner: e.owner, function: e.function });
    }
  });
  return out;
}

/**
 * Reads a plan. Layout 2 holds each task's fields in a `yaml` block under its heading and its prose under `####`
 * headings; layout 1 holds them in the heading and the `- **<Field>:**` bullets.
 */
export function readPlan(text: string, file: string, marker: Marker | null): ReadResult {
  const { data } = parseFrontMatter(text, file);
  const layout = layoutOf(data);
  refuseNewerLayout(layout, file);
  const problems: Problem[] = [];
  const doc = splitDoc(text);
  let layout2 = layout >= 2;
  if (!layout2 && data['layout'] === undefined) {
    // A plan written with fields blocks and no layout field lacks its version.
    const old = new Set(taskHeads(doc, false).map((h) => h.index));
    const heads = taskHeads(doc, true).filter((h) => !old.has(h.index));
    const withBlock = heads.some((h, n) => {
      const end = heads[n + 1]?.index ?? doc.lines.length;
      return yamlBlock(doc, h.index + 1, nextHeading(doc, h.index + 1, end, ANY_HEADING)) !== null;
    });
    if (withBlock) {
      problems.push({ file, line: 1, message: 'no layout version' });
      layout2 = true;
    }
  }
  const heads = taskHeads(doc, layout2);
  if (!layout2) {
    return { kind: 'plan', layout, document: { tasks: readTasks1(doc, heads), shared_decisions: decisions1(doc) }, problems };
  }
  const system = typeof data['system'] === 'string' ? data['system'] : '';
  const repos = marker?.systems[system]?.repos ?? null;
  const claimed = new Set<number>();
  const tasks = readTasks2(doc, heads, file, problems, repos, system, claimed);
  const shared_decisions = decisions2(doc, file, problems, claimed);
  reportUnread(doc, file, problems, [{ prefix: recordPrefix('T\\d+'), strict: HEADING2, what: 'a task heading' }], ['id'], /^\s*id\s*:\s*["']?T\d+/, claimed);
  return { kind: 'plan', layout, document: { tasks, shared_decisions }, problems };
}

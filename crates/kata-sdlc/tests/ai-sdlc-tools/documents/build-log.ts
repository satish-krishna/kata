// Reads a build log, `build/<repo>.md`: one entry per finished task. Layout in GRAMMAR.md.
import Ajv from '../vendor/ajv.mjs';
import buildLogEntrySchema from '../schema/build-log-entry.schema.json' with { type: 'json' };
import { keyLine, nextHeading, recordPrefix, reportUnread, splitDoc, yamlBlock, type Doc } from './doc.ts';
import { layoutOf, parseFrontMatter, refuseNewerLayout } from './front-matter.ts';
import { checkFields, isMissing, parseFields, textList } from './records.ts';
import type { ParsedBuildEntry, Problem, ReadResult } from '../common/types.ts';

const validateEntry = new Ajv({ allErrors: true, strict: false }).compile(buildLogEntrySchema);

const ENTRY_HEADING = /^### (T\d+)\s*$/;
const ANY_HEADING = /^#{1,3} /;

/** An entry plus what the duplicate check needs: the repository its row names, and whether it came from a table. */
type Row = ParsedBuildEntry & { repo: string; table: boolean };

/** The cells of a table line, the way `build.rs` splits it: the outer pipes dropped, every cell trimmed. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const inner = t.slice(1);
  return (inner.endsWith('|') ? inner.slice(0, -1) : inner).split('|').map((c) => c.trim());
}

const isSeparator = (row: string[]): boolean => row.every((c) => c !== '' && /^[-: ]+$/.test(c));
const isTaskId = (s: string): boolean => /^T\d+$/.test(s);

function commitsIn(cell: string): string[] {
  const parts = cell.includes('`') ? cell.split('`').filter((_, i) => i % 2 === 1) : cell.split(',');
  return parts.map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * The table rows of a layout 1 log (and of the table a layout 2 log keeps above its entries), exactly as the
 * Workbench's `rows_in` reads them: a header naming a Repository column adds one, `none` means no departure,
 * and the last column keeps any `|`. Rows inside a fenced block are not rows.
 */
function tableRows(doc: Doc): Row[] {
  let commitsAt = 1;
  let departureAt = 2;
  let repoAt: number | null = null;
  const out: Row[] = [];
  doc.lines.forEach((line, index) => {
    if (doc.fenced[index]) return;
    const row = cells(line);
    if (row === null || isSeparator(row)) return;
    if ((row[0] as string).toLowerCase() === 'task') {
      const find = (name: string): number => row.findIndex((c) => c.toLowerCase() === name);
      repoAt = find('repository') >= 0 ? find('repository') : null;
      commitsAt = find('commits') >= 0 ? find('commits') : commitsAt;
      departureAt = find('departure') >= 0 ? find('departure') : departureAt;
      return;
    }
    if (!isTaskId(row[0] as string)) return;
    const cell = (i: number): string => row[i] ?? '';
    const last = departureAt + 1 === row.length || departureAt >= row.length;
    const departure = (last ? cell(departureAt) : row.slice(departureAt).join('|')).trim();
    out.push({
      task: row[0] as string,
      repo: repoAt === null ? '' : cell(repoAt),
      commits: commitsIn(cell(commitsAt)),
      departure: departure === '' || departure.toLowerCase() === 'none' ? null : departure,
      line: index + 1,
      table: true,
    });
  });
  return out;
}

/** The layout 2 entry headings: `### T<n>` outside any fence. */
function entryHeads(doc: Doc): { index: number; id: string }[] {
  const heads: { index: number; id: string }[] = [];
  doc.lines.forEach((line, index) => {
    const m = doc.heading[index] ? ENTRY_HEADING.exec(line) : null;
    if (m) heads.push({ index, id: m[1] as string });
  });
  return heads;
}

function entryEnd(doc: Doc, heads: { index: number }[], n: number): number {
  const head = heads[n] as { index: number };
  return nextHeading(doc, head.index + 1, heads[n + 1]?.index ?? doc.lines.length, ANY_HEADING);
}

function readEntries(doc: Doc, file: string, problems: Problem[], claimed: Set<number>): Row[] {
  const heads = entryHeads(doc);
  const out: Row[] = [];
  heads.forEach((h, n) => {
    const line = h.index + 1;
    const row: Row = { task: h.id, repo: '', commits: [], departure: null, line, table: false };
    out.push(row);
    const who = `entry ${h.id}`;
    const block = yamlBlock(doc, h.index + 1, entryEnd(doc, heads, n));
    if (!block) {
      problems.push({ file, line, message: `${who} has no fields block` });
      return;
    }
    claimed.add(block.open);
    const fields = parseFields(block, who, file, problems);
    if (!fields) return;
    const f = fields.values;
    // A missing or empty commits list is reported in the entry's own words, below.
    checkFields(validateEntry, f, `${who} fields`, block, file, problems, (e) => isMissing(e, 'commits') || (e.instancePath === '/commits' && e.keyword === 'minItems'));
    if (typeof f['task'] === 'string' && f['task'] !== h.id) {
      problems.push({ file, line: keyLine(doc, block, 'task'), message: `heading says ${h.id}, fields say ${f['task']}` });
    }
    row.commits = textList(fields.text['commits']);
    if (row.commits.length === 0) problems.push({ file, line, message: `${who} has no commits` });
    const departure = fields.text['departure'];
    if (typeof departure === 'string' && departure.trim() !== '') row.departure = departure.trim();
  });
  return out;
}

/** Reads a build log. Layout 1 is a table; layout 2 is one entry per task, and a layout 2 log may keep the table above them. */
export function readBuildLog(text: string, file: string): ReadResult {
  const { data } = parseFrontMatter(text, file);
  const layout = layoutOf(data);
  refuseNewerLayout(layout, file);
  const problems: Problem[] = [];
  const doc = splitDoc(text);
  const repo = (file.split(/[\\/]/).pop() ?? '').replace(/\.md$/, '');
  let withEntries = layout >= 2;
  if (!withEntries && data['layout'] === undefined) {
    // A log written with entry blocks and no layout field lacks its version.
    const heads = entryHeads(doc);
    if (heads.some((h, n) => yamlBlock(doc, h.index + 1, entryEnd(doc, heads, n)) !== null)) {
      problems.push({ file, line: 1, message: 'no layout version' });
      withEntries = true;
    }
  }
  const claimed = new Set<number>();
  const entries = withEntries ? readEntries(doc, file, problems, claimed) : [];
  if (withEntries) reportUnread(doc, file, problems, [{ prefix: recordPrefix('T\\d+'), strict: ENTRY_HEADING, what: 'an entry heading' }], ['task'], /^\s*task\s*:\s*["']?T\d+/, claimed);
  const rows = [...tableRows(doc), ...entries].sort((a, b) => a.line - b.line);
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.repo}|${r.task}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, r.line);
    else problems.push({ file, line: r.line, message: `entry ${r.task} is recorded twice, first on line ${first}` });
    if (r.table && r.commits.length === 0) problems.push({ file, line: r.line, message: `entry ${r.task} has no commits` });
  }
  return {
    kind: 'build-log',
    layout,
    document: { repo, entries: rows.map(({ task, commits, departure, line }) => ({ task, commits, departure, line })) },
    problems,
  };
}

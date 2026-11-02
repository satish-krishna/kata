// Splits a Markdown document into lines, headings and fenced blocks, which every document reader builds on.
import type { ErrorObject } from '../vendor/ajv.mjs';
import { fromMarkdown } from '../vendor/markdown.mjs';
import { parse } from '../vendor/yaml.mjs';
import type { Problem } from '../common/types.ts';

/** A fenced code block as the CommonMark parser found it: line indexes, the fence's character and length, its info string. */
export type Fence = {
  /** The index of the opening fence line. */
  open: number;
  /** The index of the closing fence line, or -1 when the block runs to the end of the document unclosed. */
  close: number;
  /** The fence character, a backtick or a tilde. */
  char: string;
  /** The length of the opening fence. */
  length: number;
  /** The info string, trimmed. */
  info: string;
};

/**
 * A document split into lines, with the block structure the CommonMark parser found: `fenced` marks each line inside a
 * fenced code block (its fence lines included), `heading` marks each line that starts an ATX or setext heading, and
 * `fences` lists every fenced block, nested ones inside lists and quotes included. A fenced block inside a longer
 * fence is content, so it is in none of these. Line numbers are index + 1.
 */
export type Doc = { lines: string[]; fenced: boolean[]; heading: boolean[]; fences: Fence[] };

/** The parts of an mdast node this module reads. */
type MdNode = { type: string; value?: string; lang?: string | null; meta?: string | null; position?: { start: { line: number }; end: { line: number } }; children?: MdNode[] };

/** An opening fence line: any container prefix (indent, quote marker, list marker), then the fence. */
const OPENER = /^[\s>\-*+\d.]*(`{3,}|~{3,})/;

export function splitDoc(source: string): Doc {
  // Line endings are normalized before anything parses (CRLF and a lone CR both become LF, as CommonMark counts
  // them), so the parser's positions and these lines always agree.
  const text = source.replace(/\r\n|\r/g, '\n');
  const lines = text.split('\n');
  const fenced: boolean[] = lines.map(() => false);
  const heading: boolean[] = lines.map(() => false);
  const fences: Fence[] = [];
  const visit = (node: MdNode): void => {
    const at = node.position;
    if (at !== undefined && node.type === 'heading') heading[at.start.line - 1] = true;
    if (at !== undefined && node.type === 'code') {
      const open = at.start.line - 1;
      const mark = OPENER.exec(lines[open] as string)?.[1];
      // An indented code block that quotes a fence line starts with that line; a fenced block's content never does.
      const indented = node.lang == null && ((node.value ?? '').split('\n')[0] as string).trim() === (lines[open] as string).trim();
      if (mark !== undefined && !indented) {
        const char = mark[0] as string;
        const last = at.end.line - 1;
        const closing = new RegExp('^[\\s>]*' + (char === '`' ? '`' : '~') + '{' + mark.length + ',}\\s*$');
        const closed = last > open && closing.test(lines[last] as string);
        const info = `${node.lang ?? ''} ${node.meta ?? ''}`.trim();
        fences.push({ open, close: closed ? last : -1, char, length: mark.length, info });
        for (let i = open; i <= last; i++) fenced[i] = true;
      }
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(text) as MdNode);
  fences.sort((x, y) => x.open - y.open);
  return { lines, fenced, heading, fences };
}

/** The index of the next heading line at or after `from` that matches `re`, else `limit`. */
export function nextHeading(doc: Doc, from: number, limit: number, re: RegExp): number {
  for (let i = from; i < limit; i++) if (doc.heading[i] && re.test(doc.lines[i] as string)) return i;
  return limit;
}

export type Block = { text: string; open: number; first: number; last: number };

/** Whether a fenced block can hold a record's fields: its info string is `yaml` or `yml`, in any case. */
const isFieldsBlock = (f: Fence): boolean => /^(yaml|yml)$/i.test(f.info);

/** The content of a fenced block: its text, its opening line and its content lines. An unclosed block runs to the end. */
function blockOf(doc: Doc, f: Fence): Block {
  const close = f.close < 0 ? doc.lines.length : f.close;
  return { text: doc.lines.slice(f.open + 1, close).join('\n'), open: f.open, first: f.open + 1, last: close - 1 };
}

/** The first fields-block candidate that opens between two line indexes: its text, its opening line and its content lines. */
export function yamlBlock(doc: Doc, from: number, limit: number): Block | null {
  const f = doc.fences.find((x) => isFieldsBlock(x) && x.open >= from && x.open < limit);
  return f === undefined ? null : blockOf(doc, f);
}

/**
 * The prefix of a record-shaped heading: at any level from `#` to `######`, text that starts with `word` followed by a
 * word boundary. `word` is a pattern, so `T\d+` matches `T2` and `T12` but not `Testing strategy`. All three readers build
 * their prefixes here, so none can narrow the rule to one ID length or one heading level. `topLevel` raises the first
 * level counted: a review document's `# Review findings` title is the one `Review` heading that is not a record heading.
 */
export const recordPrefix = (word: string, topLevel = 1): RegExp => new RegExp(`^#{${topLevel},6}\\s*${word}\\b`);

/** A kind of record heading: any line outside a fence that starts like one must match `strict`, or it is a problem. */
export type RecordHeading = { prefix: RegExp; strict: RegExp; what: string };

/**
 * Whether a fields-block candidate holds one of `keys`: it parses to a mapping with the key, or it does not parse and
 * one of its raw lines starts with the key, so a block broken by a second mistake is still seen as a record's.
 */
function holdsRecordKey(doc: Doc, f: Fence, keys: string[]): boolean {
  const block = blockOf(doc, f);
  try {
    const data: unknown = parse(block.text);
    return typeof data === 'object' && data !== null && !Array.isArray(data) && keys.some((k) => k in data);
  } catch {
    const raw = new RegExp(`^\\s*(${keys.join('|')})\\s*:`);
    return block.text.split('\n').some((line) => raw.test(line));
  }
}

/** The fenced blocks that run to the end of the document without a closing fence; they hide every line after them. */
function unclosedFences(doc: Doc, file: string): Problem[] {
  return doc.fences
    .filter((f) => f.close < 0)
    .map((f) => ({ file, line: f.open + 1, message: `fenced block opened on line ${f.open + 1} is never closed` }));
}

/**
 * The guarantee every layout 2 reader keeps: a record-shaped line outside a fenced block that the reader did not
 * turn into a record is a problem, never a silent omission. That is a heading that starts like a record heading but
 * is not one, a fields-block candidate (a fenced block whose info string is `yaml` or `yml`) no record claimed
 * (`claimed` holds the line index of each block a record was read from) that holds one of `keys`, the reader's record
 * key, and a fenced block that is never closed, which hides every line after it. The fields block is the evidence of
 * a record, so it is reported wherever it sits and whatever heading is above it. A `yaml` example without a record
 * key is ordinary content.
 *
 * Last comes the raw-line invariant, which does not depend on how markdown is read: every line of the raw text that
 * looks like a record's key (`rawKey`, with optional leading whitespace) must be the key line of a block a record was
 * read from, wherever the line sits (an HTML block, a quote, a fence). Any other is a problem, so no construct can
 * hide a record. A line inside a block already reported above is not reported twice. The problems go in line order.
 */
export function reportUnread(
  doc: Doc,
  file: string,
  problems: Problem[],
  headings: RecordHeading[],
  keys: string[],
  rawKey: RegExp,
  claimed: Set<number>,
): void {
  const found: Problem[] = unclosedFences(doc, file);
  const covered = new Set<number>();
  const cover = (f: Fence): void => {
    const last = f.close < 0 ? doc.lines.length - 1 : f.close;
    for (let i = f.open; i <= last; i++) covered.add(i);
  };
  doc.lines.forEach((line, index) => {
    if (doc.fenced[index]) return;
    const heading = headings.find((h) => h.prefix.test(line));
    if (heading && !heading.strict.test(line)) {
      found.push({ file, line: index + 1, message: `heading "${line.trimEnd()}" is not ${heading.what}` });
    }
  });
  const keyLines = new Set<number>();
  for (const f of doc.fences) {
    if (f.close < 0) cover(f);
    if (claimed.has(f.open)) {
      const block = blockOf(doc, f);
      for (let i = block.first; i <= block.last; i++) {
        if (rawKey.test(doc.lines[i] as string)) {
          keyLines.add(i);
          break;
        }
      }
    } else if (isFieldsBlock(f) && holdsRecordKey(doc, f, keys)) {
      found.push({ file, line: f.open + 1, message: 'yaml block is not part of any record' });
      cover(f);
    }
  }
  doc.lines.forEach((line, index) => {
    if (rawKey.test(line) && !keyLines.has(index) && !covered.has(index)) {
      found.push({ file, line: index + 1, message: `${line.trim()} is not part of any record the reader found` });
    }
  });
  problems.push(...found.sort((a, b) => a.line - b.line));
}

/** The 1-based line of the first `key:` inside a block, or the block's opening line. */
export function keyLine(doc: Doc, block: Block, key: string): number {
  const re = new RegExp(`^${key}\\s*:`);
  for (let i = block.first; i <= block.last; i++) if (re.test(doc.lines[i] as string)) return i + 1;
  return block.open + 1;
}

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** One message per schema error, in the validator's order. `who` names the thing checked, `plural` how it is counted. */
export function schemaMessages(errors: ErrorObject[] | null | undefined, who: string, plural: boolean): string[] {
  const out: string[] = [];
  for (const e of errors ?? []) {
    if (e.keyword === 'required') {
      out.push(`${who} ${plural ? 'lack' : 'lacks'} ${String(e.params['missingProperty'])}`);
    } else if (e.keyword === 'additionalProperties') {
      out.push(`${who} ${plural ? 'have' : 'has'} unknown field ${String(e.params['additionalProperty'])}`);
    } else {
      const path = e.instancePath.slice(1).replace(/\//g, '.');
      out.push(`${who} field ${path === '' ? 'value' : path} ${e.message ?? 'is invalid'}`);
    }
  }
  return out;
}

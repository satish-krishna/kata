import type { Problem } from '@bindings/Problem';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';

/* The one owner of "the Workbench never shows less than a document holds without saying so". Every screen that
 * shows a spec, a plan, the build logs or the review asks here what to show and which notice goes above it: the
 * Spec, Plan and Build tabs, the Build view's findings and the done dialog. Pure, so every row of the table is
 * tested by hand. */

/** What the format program said when it could not read a document: its own message, never a guess. */
export type ReadError = { kind: 'error'; message: string };

/** `warning` is the andon warning tone with a dot and the words; `idle` is the quiet label. */
export type DocNotice = {
  tone: 'warning' | 'idle';
  text: string;
  /** One `line <n>: <message>` for each problem, led by its file when the problems span several documents; empty for every other notice. */
  lines: string[];
};

/** What to show for a document: `plain` is its text as markdown, because nothing could read it; `parsed` is what was read. */
export type Shown = { show: 'plain' | 'parsed'; notice: DocNotice | null };

/** One document's reading as the table sees it. `layout` is null for problems that belong to no one layout. */
export type Part = { layout: number | null; problems: readonly Problem[] };

const warning = (text: string, lines: string[] = []): DocNotice => ({ tone: 'warning', text, lines });

/** The plugin rows: nothing could be read, so the text is shown plain. Null when the plugin is ready. */
function unusable(readiness: Readiness): Shown | null {
  if (readiness.kind === 'missing') return { show: 'plain', notice: warning('Install the ai-sdlc plugin to read this document') };
  if (readiness.kind === 'tooOld') return { show: 'plain', notice: warning(`Update the ai-sdlc plugin to ${readiness.need} or later`) };
  return null;
}

/** The rows for what was read, checked top to bottom: a layout not accepted, then problems, then the older-layout label. */
function judge(accepted: readonly number[], parts: readonly Part[]): DocNotice | null {
  if (parts.some((p) => p.layout !== null && !accepted.includes(p.layout))) return warning('This document needs a newer Workbench');
  // Problems come before the older-layout label: a label must never hide them.
  // Two problems on line 5 of different documents must not read as the same place, so the file is named
  // whenever the problems come from more than one document.
  const found = parts.flatMap((p) => p.problems);
  const several = new Set(found.map((problem) => problem.file)).size > 1;
  const lines = found.map((problem) => `${several ? `${problem.file} ` : ''}line ${problem.line}: ${problem.message}`);
  if (lines.length > 0) return warning('This document does not follow the layout', lines);
  if (parts.some((p) => p.layout === 1)) return { tone: 'idle', text: 'Older layout', lines: [] };
  return null;
}

/**
 * What to show for one spec or plan, and the notice above it. `read` is what the format program printed, its error
 * when it could not read the document, or null when there is nothing to read. The rows, top to bottom:
 *
 * | readiness | read | layout | problems | shown |
 * |---|---|---|---|---|
 * | missing | any | any | any | plain text; install notice |
 * | too old | any | any | any | plain text; update notice |
 * | ready | could not read | n/a | n/a | plain text; the program's message |
 * | ready | read | not accepted | any | what was read; needs a newer Workbench |
 * | ready | read | accepted | some | what was read; each problem as `line <n>: <message>`, led by its file when they span several documents |
 * | ready | read | 1 | none | what was read; "Older layout" |
 * | ready | read | 2 or later, accepted | none | what was read; no notice |
 */
export function shownDocument(read: ReadResult | ReadError | null, readiness: Readiness): Shown {
  const stop = unusable(readiness);
  if (stop !== null) return stop;
  if (readiness.kind !== 'ready' || read === null) return { show: 'plain', notice: null };
  if (read.kind === 'error') return { show: 'plain', notice: warning(`Could not read this document: ${read.message}`) };
  return { show: 'parsed', notice: judge(readiness.layouts, [read]) };
}

/**
 * The Build tab's notice, from every document it shows: the plan's and build logs' problems, each log's layout and
 * the review's. The rows are the same, over all of them at once, so a problem in one is never hidden behind the
 * older-layout label of another.
 */
export function shownBuild(parts: readonly Part[], readiness: Readiness): Shown {
  const stop = unusable(readiness);
  if (stop !== null) return stop;
  if (readiness.kind !== 'ready') return { show: 'plain', notice: null };
  return { show: 'parsed', notice: judge(readiness.layouts, parts) };
}

/**
 * The notice above the change list when some plan could not be read, so its stage is withheld. The plugin rows
 * keep their wording from `shownDocument`; a usable plugin means the program itself could not run or read the plan.
 */
export function shownChangeList(readiness: Readiness, anyUnreadable: boolean): DocNotice | null {
  if (!anyUnreadable) return null;
  const stop = unusable(readiness);
  if (stop !== null) return stop.notice;
  return warning('A plan could not be read, so its stage is not shown. Check that Node.js 20 or later is installed');
}

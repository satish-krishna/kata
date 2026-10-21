import type { Problem } from '@bindings/Problem';
import type { Readiness } from '@bindings/Readiness';

/* Which notice a document gets above it: a plugin that cannot read it, a layout newer than the Workbench knows, a
 * problem the format program found, or the quiet label of the older layout. Pure, so the change page and its tests
 * share one reading of the table. */

/** The layout versions the Workbench reads; the backend's `ACCEPTED_LAYOUTS`. */
export const ACCEPTED_LAYOUTS: readonly number[] = [1, 2];

/** `warning` is the andon warning tone with a dot and the words; `idle` is the quiet label. */
export type DocNotice = {
  tone: 'warning' | 'idle';
  text: string;
  /** One `line <n>: <message>` for each problem; empty for every other notice. */
  lines: string[];
  /** The document is shown as plain markdown, because nothing could read it. */
  plain: boolean;
};

/** The notice for a document, or null when it needs none. The rows are checked top to bottom. */
export function docNotice(layout: number, problems: readonly Problem[], readiness: Readiness): DocNotice | null {
  if (readiness.kind === 'missing') return { tone: 'warning', text: 'Install the ai-sdlc plugin to read this document', lines: [], plain: true };
  if (readiness.kind === 'tooOld') return { tone: 'warning', text: `Update the ai-sdlc plugin to ${readiness.need} or later`, lines: [], plain: true };
  if (layout > Math.max(...ACCEPTED_LAYOUTS)) return { tone: 'warning', text: 'This document needs a newer Workbench', lines: [], plain: false };
  // The program reports no problems for the older layout, so a problem list there cannot happen.
  if (layout < 2) return { tone: 'idle', text: 'Older layout', lines: [], plain: false };
  if (problems.length > 0) {
    return { tone: 'warning', text: 'This document does not follow the layout', lines: problems.map((p) => `line ${p.line}: ${p.message}`), plain: false };
  }
  return null;
}

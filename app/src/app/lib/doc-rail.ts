import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { RunRecord } from '@bindings/RunRecord';

/* What the change page's document strip and rail say about a document: its status in words, what uses it and its
 * recent runs. Pure, so the view model and its tests share one reading of each. */

export type DocTone = 'success' | 'warning' | 'error' | 'idle';
/** A document status as a word and the tone of its dot. */
export type DocStatus = { text: string; tone: DocTone };
/** The document that is built from the open one, with its own status. */
export type UsedBy = { name: string; status: DocStatus | null };
/** One run in the rail: what it was, when it started, and how it ended. */
export type RunRow = { id: string; kind: string; time: string; tone: DocTone };

const TONES: Record<string, DocTone> = { accepted: 'success', draft: 'warning', superseded: 'error', rejected: 'error' };

/** A raw front-matter `status` as a word with a dot tone, or null when there is none. Unlisted words are idle. */
export function docStatus(raw: string | null | undefined): DocStatus | null {
  const word = raw?.trim().replaceAll('-', ' ') ?? '';
  if (word === '') return null;
  return { text: word.charAt(0).toUpperCase() + word.slice(1), tone: TONES[word.toLowerCase()] ?? 'idle' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** A start time in epoch seconds as `Oct 20 10:05`, in the local zone. */
export function runTime(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const RECENT = 3;

/** The first three of a stage's runs (newest first, as `stageRuns` gives them) as rail rows, and how many there are. */
export function recentRuns(runs: readonly RunRecord[], kind: string): { rows: RunRow[]; total: number } {
  const rows = runs.slice(0, RECENT).map((r) => ({
    id: r.id,
    kind,
    time: runTime(r.started_at),
    tone: r.exit === undefined || r.exit === null ? ('idle' as const) : r.exit === 0 ? ('success' as const) : ('error' as const),
  }));
  return { rows, total: runs.length };
}

/** The document built from this one: the intent is used by the spec and the spec by the plan; the plan by none. */
export function usedBy(stem: 'intent' | 'spec' | 'plan', c: Pick<ChangeInfo, 'spec' | 'plan'>): UsedBy | null {
  const next = stem === 'intent' ? { name: 'spec.md', doc: c.spec } : stem === 'spec' ? { name: 'plan.md', doc: c.plan } : null;
  return next !== null && next.doc.exists ? { name: next.name, status: docStatus(next.doc.status) } : null;
}

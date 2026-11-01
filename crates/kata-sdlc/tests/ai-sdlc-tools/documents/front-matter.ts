// Reads a document's YAML front matter and its layout number, and refuses a layout newer than this program reads.
import { parse } from '../vendor/yaml.mjs';
import { CouldNotRun, READS_LAYOUTS } from '../common/types.ts';

export type FrontMatter = {
  /** The parsed fields; empty when the document has no front matter. */
  data: Record<string, unknown>;
  /** The 1-based line the body starts on (the line after the closing fence). */
  bodyLine: number;
};

/** The lines of a text as the front matter reader splits them, and the 0-based index of the closing fence (-1 when there is none); null when the text does not open with a fence. */
function fenceLines(text: string): { lines: string[]; close: number } | null {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== '---') return null;
  return { lines, close: lines.findIndex((l, i) => i > 0 && l.trim() === '---') };
}

/**
 * The 1-based number of the line closing the front matter, counted in lines ended by `\n` as git counts them;
 * 0 when the text has no front matter or never closes it. It finds the fences exactly as `parseFrontMatter` does.
 */
export function frontMatterCloseLine(text: string): number {
  const found = fenceLines(text);
  if (found === null || found.close < 0) return 0;
  // The offset of the closing line: the lengths of the lines before it and of their line endings.
  const parts = text.split(/(\r\n|\r|\n)/);
  let offset = 0;
  for (let i = 0; i < found.close * 2; i++) offset += (parts[i] as string).length;
  return text.slice(0, offset).split('\n').length;
}

/** Reads the `---` fenced YAML block at the top of a document. */
export function parseFrontMatter(text: string, file: string): FrontMatter {
  const found = fenceLines(text);
  if (found === null) return { data: {}, bodyLine: 1 };
  const { lines, close } = found;
  if (close < 0) throw new CouldNotRun(`${file}: front matter is never closed`);
  let data: unknown;
  try {
    data = parse(lines.slice(1, close).join('\n'));
  } catch (e) {
    throw new CouldNotRun(`${file}: front matter is not valid YAML: ${(e as Error).message}`);
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new CouldNotRun(`${file}: front matter is not a set of fields`);
  }
  return { data: data as Record<string, unknown>, bodyLine: close + 2 };
}

/** A document's layout version: the `layout` field as an integer, 1 when absent. */
export function layoutOf(frontMatter: Record<string, unknown>): number {
  const value = frontMatter['layout'];
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CouldNotRun(`layout must be a whole number of 1 or more, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Refuses a layout this program does not read (exit 2). */
export function refuseNewerLayout(layout: number, file: string): void {
  if (!READS_LAYOUTS.includes(layout)) {
    throw new CouldNotRun(
      `${file}: layout ${layout} is newer than this program reads (it reads ${READS_LAYOUTS.join(', ')}); update the ai-sdlc plugin`,
    );
  }
}

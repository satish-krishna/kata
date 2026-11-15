// Picks the reader for a document from its file name, and reads it.
import { readFileSync } from 'node:fs';
import { CouldNotRun, type DocKind, type ReadResult } from '../common/types.ts';
import { findMarker } from '../workspace/marker.ts';
import { readBuildLog } from './build-log.ts';
import { readPlan } from './plan.ts';
import { readReview } from './review.ts';
import { readSpec } from './spec.ts';

/** The document kind comes from the file name. */
export function kindOf(file: string): DocKind {
  const parts = file.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? '';
  const parent = parts[parts.length - 2] ?? '';
  if (name === 'spec.md') return 'spec';
  if (name === 'plan.md') return 'plan';
  if (parent === 'build' && name === 'review.md') return 'review';
  if (parent === 'build' && name.endsWith('.md')) return 'build-log';
  throw new CouldNotRun(
    `${file}: not a document this program knows (expected spec.md, plan.md, build/<repo>.md or build/review.md)`,
  );
}

/** Reads one document. Each kind of document has its own reader. */
export function readDocument(file: string): ReadResult {
  const kind = kindOf(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new CouldNotRun(`${file}: cannot read the file: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
  if (kind === 'spec') return readSpec(text, file);
  if (kind === 'plan') return readPlan(text, file, findMarker(file));
  if (kind === 'build-log') return readBuildLog(text, file);
  return readReview(text, file);
}

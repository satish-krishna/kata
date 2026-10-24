// Reading and writing the remembered arrangements of the build page, one per mode.
import { type Arrangement, type LayoutMode } from './build-layout';

export function readLayoutFile(_raw: unknown): Record<LayoutMode, Arrangement | null> {
  return { overview: null, watch: null, changes: null, review: null };
}

export function writeLayoutFile(_modes: Partial<Record<LayoutMode, Arrangement>>): Record<string, unknown> {
  throw new Error('not implemented');
}

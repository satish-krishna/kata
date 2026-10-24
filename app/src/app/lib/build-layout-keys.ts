import type { LayoutMode } from './build-layout';

/** What a key on the build page asks for: one of the four modes, or the end of a focus. */
export type LayoutKey = { kind: 'mode'; mode: LayoutMode } | { kind: 'unfocus' };

export function layoutKeyFor(_e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): LayoutKey | null {
  return null;
}

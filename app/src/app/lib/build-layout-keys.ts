import type { LayoutMode } from './build-layout';

/** What a key on the build page asks for: one of the four modes, or the end of a focus. */
export type LayoutKey = { kind: 'mode'; mode: LayoutMode } | { kind: 'unfocus' };

const MODE_KEYS: Record<string, LayoutMode> = { '1': 'overview', '2': 'watch', '3': 'changes', '4': 'review' };

/** Ctrl (Cmd on macOS) with 1 to 4 picks a mode; Esc ends a focus. Alt and Shift are excluded because AltGr on Windows reports Ctrl+Alt. */
export function layoutKeyFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): LayoutKey | null {
  if (e.altKey || e.shiftKey) return null;
  if (e.ctrlKey || e.metaKey) {
    const mode = Object.hasOwn(MODE_KEYS, e.key) ? MODE_KEYS[e.key] : undefined;
    return mode === undefined ? null : { kind: 'mode', mode };
  }
  return e.key === 'Escape' ? { kind: 'unfocus' } : null;
}

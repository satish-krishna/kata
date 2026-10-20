/** A step of the window's zoom; the backend owns the levels and remembers the result. */
export type ZoomStep = 'in' | 'out' | 'reset';

/** Ctrl (Cmd on macOS) with = or +, -, or 0. Alt is excluded because AltGr on Windows reports Ctrl+Alt. */
export function zoomStepFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): ZoomStep | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  switch (e.key) {
    case '=':
    case '+':
      return 'in';
    case '-':
      return 'out';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

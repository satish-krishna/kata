import type { MonacoApi } from './monaco.loader';

export const KATA_THEME = 'kata';

/** `#rrggbb` plus an alpha byte; any other form (empty, a named color) passes through unchanged. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

/**
 * Defines the `kata` Monaco theme from the live color tokens, so the editor follows the
 * accent and surfaces in one place. Monaco needs literal colors, so the tokens are read
 * off the document at load time; a token that does not resolve is left out and Monaco
 * falls back to the dark base for that slot.
 */
export function defineKataTheme(monaco: MonacoApi, css: CSSStyleDeclaration): void {
  const token = (name: string) => css.getPropertyValue(name).trim();
  const colors: Record<string, string> = {
    'editor.background': token('--surface-inset'),
    'editor.foreground': token('--text-primary'),
    'editorLineNumber.foreground': token('--text-faint'),
    'editorLineNumber.activeForeground': token('--text-secondary'),
    'editorCursor.foreground': token('--accent'),
    'editor.selectionBackground': withAlpha(token('--accent'), 0.3),
    'editor.inactiveSelectionBackground': withAlpha(token('--accent'), 0.15),
    'editor.lineHighlightBackground': token('--surface-hover'),
    'editorWidget.background': token('--surface-card'),
    'editorWidget.border': token('--border-default'),
    'editorGutter.background': token('--surface-inset'),
    'editorIndentGuide.background1': token('--border-subtle'),
    'scrollbarSlider.background': withAlpha(token('--ink-400'), 0.5),
    'diffEditor.insertedTextBackground': withAlpha(token('--success'), 0.22),
    'diffEditor.insertedLineBackground': withAlpha(token('--success'), 0.12),
    'diffEditor.removedTextBackground': withAlpha(token('--error'), 0.22),
    'diffEditor.removedLineBackground': withAlpha(token('--error'), 0.12),
    'diffEditor.unchangedRegionBackground': token('--surface-panel'),
    'diffEditor.unchangedRegionForeground': token('--text-muted'),
    'diffEditor.border': token('--border-default'),
  };
  const defined = Object.fromEntries(Object.entries(colors).filter(([, value]) => value !== ''));
  monaco.editor.defineTheme(KATA_THEME, { base: 'vs-dark', inherit: true, rules: [], colors: defined });
}

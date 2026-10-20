/** Mermaid diagrams for rendered markdown. The library is large, so it loads on the first diagram,
 *  never at startup. `securityLevel: 'strict'` makes Mermaid sanitize labels and drop click handlers. */
type Mermaid = typeof import('mermaid').default;
export type DiagramTheme = Record<string, string | boolean>;

let loading: Promise<Mermaid> | null = null;
let seq = 0;

export const diagrams = {
  async render(source: string, theme: DiagramTheme): Promise<string> {
    loading ??= import('mermaid').then((m) => m.default);
    const mermaid = await loading;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: theme, fontFamily: String(theme['fontFamily']) });
    const id = `k-mermaid-${++seq}`;
    try {
      return (await mermaid.render(id, source)).svg;
    } finally {
      // A failed render can leave its scratch element in the document.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  },
};

/** Mermaid's base theme needs literal colors, so read the Kata tokens off the element at render time. */
export function diagramTheme(css: CSSStyleDeclaration): DiagramTheme {
  const t = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: true,
    fontFamily: t('--font-sans'),
    fontSize: '13px',
    // Kata cards are flat at rest; Mermaid's themes add a shadow under every node.
    dropShadow: 'none',
    background: t('--surface-inset'),
    mainBkg: t('--surface-card'),
    primaryColor: t('--surface-card'),
    primaryTextColor: t('--text-primary'),
    primaryBorderColor: t('--border-strong'),
    nodeBorder: t('--border-strong'),
    secondaryColor: t('--surface-panel'),
    tertiaryColor: t('--surface-hover'),
    textColor: t('--text-secondary'),
    lineColor: t('--text-muted'),
    clusterBkg: t('--surface-panel'),
    clusterBorder: t('--border-default'),
    edgeLabelBackground: t('--surface-inset'),
    noteBkgColor: t('--surface-panel'),
    noteTextColor: t('--text-secondary'),
    noteBorderColor: t('--border-default'),
    actorBkg: t('--surface-card'),
    actorBorder: t('--border-strong'),
    actorTextColor: t('--text-primary'),
    signalColor: t('--text-secondary'),
    signalTextColor: t('--text-secondary'),
  };
}

import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-nested-flex-grid.md.

export type Options = [];
export type MessageIds = 'nestedFlexGrid';
export const RULE_NAME = 'no-nested-flex-grid';

const baseUtil = (t: string): string => (t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t);

function classTokens(node: TmplAstElement): string[] {
  const attr = (node.attributes ?? []).find((a) => a.name === 'class');
  return attr && typeof attr.value === 'string'
    ? attr.value.split(/\s+/).filter(Boolean).map(baseUtil)
    : [];
}

// A structural view of the fields isElement checks; `n` arrives as one of
// TmplAstElement's generic Node children, none of which declare `name` or
// `attributes` on the base type, so the duck-type check is narrowed via
// `unknown` rather than assumed.
function isElement(n: unknown): n is TmplAstElement {
  const c = n as { readonly name?: unknown; readonly attributes?: unknown } | null | undefined;
  return !!c && typeof c.name === 'string' && Array.isArray(c.attributes);
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a flex row of flex columns, which is a grid written as nested flex.',
    },
    schema: [],
    messages: {
      nestedFlexGrid:
        'Layout grammar: this is a flex row containing {{count}} flex-col children, which lays out as a ' +
        'grid. Use grid for two-dimensional regions (grid grid-cols-* gap-*) and keep flex for ' +
        'single-axis runs. See the house-style skill, "Do not nest flex to fake a grid". A flex COLUMN ' +
        'of flex rows is fine and is not what this rule flags.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    return {
      Element(node: TmplAstElement) {
        const own = classTokens(node);
        // A row: flex, and not flex-col.
        if (!own.includes('flex') || own.includes('flex-col')) return;
        const colKids = (node.children ?? []).filter((c) => {
          if (!isElement(c)) return false;
          const k = classTokens(c);
          return k.includes('flex') && k.includes('flex-col');
        });
        if (colKids.length < 2) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'nestedFlexGrid',
          data: { count: colKids.length },
        });
      },
    };
  },
});

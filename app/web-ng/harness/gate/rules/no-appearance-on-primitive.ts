import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { PRIMITIVE_ATTRS, PRIMITIVE_ELEMENTS } from './primitive-vocabulary.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-appearance-on-primitive.md.
//
// The primitive sets (PRIMITIVE_ATTRS, PRIMITIVE_ELEMENTS) are gate-internal
// shared state - see ./primitive-vocabulary.ts. Rule no-unknown-primitive
// reuses the same module; only cross-ENGINE sharing with the counter is
// forbidden, not gate-internal sharing.

export type Options = [];
export type MessageIds = 'appearanceOnPrimitive';
export const RULE_NAME = 'no-appearance-on-primitive';

const isPrimitive = (node: TmplAstElement): boolean =>
  PRIMITIVE_ELEMENTS.has(node.name) || node.attributes.some((a) => PRIMITIVE_ATTRS.has(a.name));

const classTokens = (node: TmplAstElement): string[] => {
  const attr = node.attributes.find((a) => a.name === 'class');
  return attr && typeof attr.value === 'string' ? attr.value.split(/\s+/).filter(Boolean) : [];
};

const baseUtil = (t: string): string => (t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t);

// Appearance: color, typography, decoration, internal padding. Everything else
// (display, flex/grid arrangement, dimensions, margins, position) is layout.
const APPEARANCE_RE =
  /^(bg-|text-(?!left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$)|font-|leading-|tracking-|border($|-)|rounded($|-)|shadow($|-)|ring($|-)|p[xytblrse]?-)/;
const isAppearance = (t: string): boolean => APPEARANCE_RE.test(baseUtil(t));

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow appearance-override classes on a spartan primitive.' },
    schema: [],
    messages: {
      appearanceOnPrimitive:
        'Sealed vocabulary: "{{token}}" overrides the appearance of <{{element}}>. Class on a primitive is for layout only; change its look through a variant input or the Helm file in libs/ui.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    return {
      Element(node: TmplAstElement) {
        if (!isPrimitive(node)) return;
        const offender = classTokens(node).find(isAppearance);
        if (!offender) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'appearanceOnPrimitive',
          data: { element: node.name, token: offender },
        });
      },
    };
  },
});

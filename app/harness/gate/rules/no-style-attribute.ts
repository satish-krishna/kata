import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-style-attribute.md.

export type Options = [];
export type MessageIds = 'styleAttribute';
export const RULE_NAME = 'no-style-attribute';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a static inline style attribute.' },
    schema: [],
    messages: {
      styleAttribute:
        'Sealed vocabulary: a static style attribute on <{{element}}> is a raw literal. Style belongs in a token or the primitive; a computed [style.x] binding is fine, a hardcoded style attribute is not.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    return {
      Element(node: TmplAstElement) {
        const hasStaticStyle = node.attributes.some((a) => a.name === 'style');
        if (!hasStaticStyle) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'styleAttribute',
          data: { element: node.name },
        });
      },
    };
  },
});

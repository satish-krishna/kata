import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-raw-icon.md.

export type Options = [];
export type MessageIds = 'rawIcon';
export const RULE_NAME = 'no-raw-icon';

const SVG_ROOT_NAME = ':svg:svg';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a raw inline <svg> element; use <ng-icon> instead.',
    },
    schema: [],
    messages: {
      rawIcon:
        'Sealed vocabulary: an inline <svg> bypasses the icon registry. Replace it with ' +
        '<ng-icon name="lucide..."> and register the icon via provideIcons on the component.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    return {
      Element(node: TmplAstElement) {
        if (node.name !== SVG_ROOT_NAME) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'rawIcon',
        });
      },
    };
  },
});

import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-ng-class-style.md.

export type Options = [];
export type MessageIds = 'ngClassStyle';
export const RULE_NAME = 'no-ng-class-style';

const NG_CLASS_STYLE = new Set(['ngClass', 'ngStyle']);
const REPLACEMENT: Record<string, string> = { ngClass: '[class.x] or [class]', ngStyle: '[style.x] or [style]' };

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow ngClass/ngStyle; use class/style bindings.' },
    schema: [],
    messages: {
      ngClassStyle:
        'Template modernity: do not use {{name}}. Use a binding instead: {{replacement}} (for example [class.active]="isActive()").',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    const check = (node: TmplAstElement) => {
      const all = [...(node.attributes ?? []), ...(node.inputs ?? [])];
      const hit = all.find((a) => NG_CLASS_STYLE.has(a.name));
      if (!hit) return;
      context.report({
        loc: parserServices.convertElementSourceSpanToLoc(context, node),
        messageId: 'ngClassStyle',
        data: { name: hit.name, replacement: REPLACEMENT[hit.name] },
      });
    };
    return { Element: check, 'Element$1': check };
  },
});

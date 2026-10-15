import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-forms-module.md.

export type Options = [];
export type MessageIds = 'formsModule';
export const RULE_NAME = 'no-forms-module';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow FormsModule (template-driven forms) in a component.' },
    schema: [],
    messages: {
      formsModule:
        'Component shape: template-driven forms are not used here. Remove FormsModule; author the form with signal-forms and a zod schema.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node: TSESTree.ClassDeclaration) {
        const obj = componentDecoratorObject(node);
        if (!obj) return;
        const imp = obj.properties.find(
          (p): p is TSESTree.Property =>
            p.type === 'Property' && !!p.key && p.key.type === 'Identifier' && p.key.name === 'imports',
        );
        if (!imp || imp.value.type !== 'ArrayExpression') return;
        for (const el of imp.value.elements) {
          if (el && el.type === 'Identifier' && el.name === 'FormsModule') {
            context.report({ node: el, messageId: 'formsModule' });
          }
        }
      },
    };
  },
});

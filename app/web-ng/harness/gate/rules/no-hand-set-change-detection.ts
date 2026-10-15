import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-hand-set-change-detection.md.

export type Options = [];
export type MessageIds = 'handSetChangeDetection';
export const RULE_NAME = 'no-hand-set-change-detection';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an explicit changeDetection in @Component; OnPush is the v22 default.' },
    schema: [],
    messages: {
      handSetChangeDetection:
        'Component shape: do not set changeDetection explicitly. OnPush is the Angular v22 default; remove the changeDetection property.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node: TSESTree.ClassDeclaration) {
        const obj = componentDecoratorObject(node);
        if (!obj) return;
        const prop = obj.properties.find(
          (p) =>
            p.type === 'Property' &&
            p.key &&
            ((p.key.type === 'Identifier' && p.key.name === 'changeDetection') ||
              (p.key.type === 'Literal' && p.key.value === 'changeDetection')),
        );
        if (prop) context.report({ node: prop, messageId: 'handSetChangeDetection' });
      },
    };
  },
});

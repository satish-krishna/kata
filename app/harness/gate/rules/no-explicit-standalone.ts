import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-explicit-standalone.md.

export type Options = [];
export type MessageIds = 'explicitStandalone';
export const RULE_NAME = 'no-explicit-standalone';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an explicit standalone in @Component; standalone is the v20+ default.' },
    schema: [],
    messages: {
      explicitStandalone:
        'Component shape: do not set standalone explicitly. Standalone is the Angular v20+ default (see CLAUDE.md ' +
        'and harness/rules/no-explicit-standalone.md); remove the standalone property.',
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
            ((p.key.type === 'Identifier' && p.key.name === 'standalone') ||
              (p.key.type === 'Literal' && p.key.value === 'standalone')),
        );
        if (prop) context.report({ node: prop, messageId: 'explicitStandalone' });
      },
    };
  },
});

import type { TSESTree } from '@typescript-eslint/utils';
import { inComponentOrViewModelClass } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-component-subscribe.md.

export type Options = [];
export type MessageIds = 'componentSubscribe';
export const RULE_NAME = 'no-component-subscribe';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow .subscribe() inside a component class or a ViewModel.' },
    schema: [],
    messages: {
      componentSubscribe:
        'Component shape: no .subscribe in a component or ViewModel. Convert at the edge and bind with the async pipe or toSignal.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const c = node.callee;
        if (
          c &&
          c.type === 'MemberExpression' &&
          c.property &&
          c.property.type === 'Identifier' &&
          c.property.name === 'subscribe' &&
          inComponentOrViewModelClass(node)
        ) {
          context.report({ node, messageId: 'componentSubscribe' });
        }
      },
    };
  },
});

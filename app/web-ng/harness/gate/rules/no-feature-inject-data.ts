import type { TSESTree } from '@typescript-eslint/utils';
import { inComponentClass, isDataServiceToken, isUiPath } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-feature-inject-data.md.

export type Options = [];
export type MessageIds = 'featureInjectsData';
export const RULE_NAME = 'no-feature-inject-data';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a feature component injecting a data service directly; the ViewModel does that.',
    },
    schema: [],
    messages: {
      featureInjectsData:
        'Component shape: a feature component injects no data service. Move inject({{token}}) into the ' +
        'component-scoped ViewModel (see harness/rules/no-feature-inject-data.md) and inject the ViewModel here instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? (context.getFilename && context.getFilename()) ?? '';
    if (isUiPath(filename)) return {};
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const c = node.callee;
        if (
          c &&
          c.type === 'Identifier' &&
          c.name === 'inject' &&
          node.arguments.length &&
          node.arguments[0].type === 'Identifier'
        ) {
          const token = node.arguments[0].name;
          if (isDataServiceToken(token) && inComponentClass(node)) {
            context.report({ node, messageId: 'featureInjectsData', data: { token } });
          }
        }
      },
    };
  },
});

import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-legacy-icon-module.md.

export type Options = [];
export type MessageIds = 'legacyIconModule';
export const RULE_NAME = 'no-legacy-icon-module';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow NgIconsModule (the legacy icon module) in a component.' },
    schema: [],
    messages: {
      legacyIconModule:
        'Component shape: NgIconsModule is the legacy icon module and throws at bootstrap here. Import NgIcon ' +
        'instead and register icons with provideIcons(...) (see harness/rules/no-legacy-icon-module.md).',
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
          if (el && el.type === 'Identifier' && el.name === 'NgIconsModule') {
            context.report({ node: el, messageId: 'legacyIconModule' });
          }
        }
      },
    };
  },
});

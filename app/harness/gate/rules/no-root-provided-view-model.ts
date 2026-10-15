import type { TSESTree } from '@typescript-eslint/utils';
import { isViewModelName, decoratorObjectByNames } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-root-provided-view-model.md.

export type Options = [];
export type MessageIds = 'vmNotComponentScoped';
export const RULE_NAME = 'no-root-provided-view-model';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a providedIn ViewModel; ViewModels are component-scoped.' },
    schema: [],
    messages: {
      vmNotComponentScoped:
        'Component shape: {{name}} is a ViewModel, which is component-scoped. Remove providedIn from its ' +
        '@Injectable/@Service and list {{name}} in the owning component\'s own providers instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node: TSESTree.ClassDeclaration) {
        const name = node.id && node.id.name;
        if (!isViewModelName(name)) return;
        const obj = decoratorObjectByNames(node, ['Injectable', 'Service']);
        if (!obj) return;
        const prop = obj.properties.find(
          (p) =>
            p.type === 'Property' &&
            p.key &&
            ((p.key.type === 'Identifier' && p.key.name === 'providedIn') ||
              (p.key.type === 'Literal' && p.key.value === 'providedIn')),
        );
        if (prop) context.report({ node: prop, messageId: 'vmNotComponentScoped', data: { name } });
      },
    };
  },
});

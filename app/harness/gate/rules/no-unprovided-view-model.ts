import type { TSESTree } from '@typescript-eslint/utils';
import { isViewModelName, nearestComponentClass, componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-unprovided-view-model.md.

export type Options = [];
export type MessageIds = 'vmNotProvided';
export const RULE_NAME = 'no-unprovided-view-model';

function providersInfo(classNode: TSESTree.ClassDeclaration | TSESTree.ClassExpression): {
  names: Set<string>;
  hasSpread: boolean;
} {
  const obj = componentDecoratorObject(classNode);
  const names = new Set<string>();
  let hasSpread = false;
  if (obj) {
    const providersProp = obj.properties.find(
      (p): p is TSESTree.Property =>
        p.type === 'Property' && !!p.key && p.key.type === 'Identifier' && p.key.name === 'providers',
    );
    if (providersProp && providersProp.value.type === 'ArrayExpression') {
      for (const el of providersProp.value.elements) {
        if (el && el.type === 'Identifier') names.add(el.name);
        if (el && el.type === 'SpreadElement') hasSpread = true;
      }
    }
  }
  return { names, hasSpread };
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow injecting a ViewModel without listing it in the component providers.' },
    schema: [],
    messages: {
      vmNotProvided:
        'Component shape: {{name}} is injected but not provided, which is a NullInjectorError at runtime. ' +
        'Add providers: [{{name}}] to this component\'s @Component metadata (see harness/rules/no-unprovided-view-model.md).',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const c = node.callee;
        if (!(c && c.type === 'Identifier' && c.name === 'inject')) return;
        if (!node.arguments.length || node.arguments[0].type !== 'Identifier') return;
        const name = node.arguments[0].name;
        if (!isViewModelName(name)) return;
        const classNode = nearestComponentClass(node);
        if (!classNode) return;
        const { names, hasSpread } = providersInfo(classNode);
        if (!hasSpread && !names.has(name)) {
          context.report({ node, messageId: 'vmNotProvided', data: { name } });
        }
      },
    };
  },
});

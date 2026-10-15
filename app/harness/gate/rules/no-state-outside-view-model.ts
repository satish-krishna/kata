import type { TSESTree } from '@typescript-eslint/utils';
import { hasComponentDecorator, isUiPath } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-state-outside-view-model.md.

export type Options = [];
export type MessageIds = 'stateOutsideVm';
export const RULE_NAME = 'no-state-outside-view-model';

const STATE_FNS = new Set(['signal', 'computed', 'linkedSignal']);

function formArgPropertyName(arg: TSESTree.Expression | TSESTree.SpreadElement | undefined): string | null {
  if (!arg) return null;
  if (arg.type === 'Identifier') return arg.name;
  if (arg.type === 'MemberExpression' && arg.object.type === 'ThisExpression' && arg.property.type === 'Identifier') {
    return arg.property.name;
  }
  return null;
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a feature component declaring its own state signal or form; state lives in the ViewModel.',
    },
    schema: [],
    messages: {
      stateOutsideVm:
        'Component shape: a feature component holds no state of its own. Move this {{name}}(...) into the ' +
        'component-scoped ViewModel (see harness/rules/no-state-outside-view-model.md) and read it off the injected vm instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? (context.getFilename && context.getFilename()) ?? '';
    if (isUiPath(filename)) return {};
    const formLocalNames = new Set<string>();
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.source && node.source.value === '@angular/forms/signals') {
          for (const s of node.specifiers) {
            if (s.type === 'ImportSpecifier' && s.imported && s.imported.type === 'Identifier' && s.imported.name === 'form') {
              formLocalNames.add(s.local.name);
            }
          }
        }
      },
      ClassDeclaration(classNode: TSESTree.ClassDeclaration) {
        if (!hasComponentDecorator(classNode)) return;
        const members = classNode.body.body.filter(
          (m): m is TSESTree.PropertyDefinition & { value: TSESTree.Expression } =>
            m.type === 'PropertyDefinition' && m.value !== null,
        );

        const absorbedIntoForm = new Set<string>();
        for (const member of members) {
          const v = member.value;
          if (v.type === 'CallExpression' && v.callee.type === 'Identifier' && formLocalNames.has(v.callee.name)) {
            const modelName = formArgPropertyName(v.arguments[0]);
            if (modelName) absorbedIntoForm.add(modelName);
          }
        }

        for (const member of members) {
          const v = member.value;
          if (v.type !== 'CallExpression' || v.callee.type !== 'Identifier') continue;
          const isForm = formLocalNames.has(v.callee.name);
          const isState = STATE_FNS.has(v.callee.name);
          if (!isForm && !isState) continue;
          const key = member.key;
          const memberName = key && key.type === 'Identifier' ? key.name : null;
          if (isState && memberName && absorbedIntoForm.has(memberName)) continue;
          context.report({ node: member, messageId: 'stateOutsideVm', data: { name: isForm ? 'form' : v.callee.name } });
        }
      },
    };
  },
});

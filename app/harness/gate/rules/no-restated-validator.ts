import type { TSESTree } from '@typescript-eslint/utils';
import { inComponentClass } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-restated-validator.md.

export type Options = [];
export type MessageIds = 'restatedValidator';
export const RULE_NAME = 'no-restated-validator';

const VALIDATORS = new Set(['required', 'minLength', 'maxLength', 'min', 'max', 'email', 'pattern']);

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a per-field signal-forms validator the zod schema already owns.' },
    schema: [],
    messages: {
      restatedValidator:
        'Component shape: validation lives in the zod schema. Remove {{name}}(...) and validate through validateStandardSchema(path, schema).',
    },
  },
  defaultOptions: [],
  create(context) {
    // Track only the validator names actually imported from @angular/forms/signals,
    // under their local (possibly aliased) name.
    const imported = new Set<string>();
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.source && node.source.value === '@angular/forms/signals') {
          for (const s of node.specifiers) {
            if (s.type === 'ImportSpecifier' && s.imported && s.imported.type === 'Identifier' && VALIDATORS.has(s.imported.name)) {
              imported.add(s.local.name);
            }
          }
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        const c = node.callee;
        if (c && c.type === 'Identifier' && imported.has(c.name) && inComponentClass(node)) {
          context.report({ node, messageId: 'restatedValidator', data: { name: c.name } });
        }
      },
    };
  },
});

import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-reactive-form.md.

export type Options = [];
export type MessageIds = 'reactiveForm';
export const RULE_NAME = 'no-reactive-form';

const REACTIVE = new Set(['FormGroup', 'FormControl', 'FormBuilder', 'FormArray']);

// The walk below descends into an arbitrary AST subtree looking for a `new`
// of one of the reactive-forms classes, so the value at each step is not a
// known TSESTree node shape until its own `type` field is checked. `unknown`
// plus this narrowing helper keeps that check honest instead of assuming a
// shape, mirroring the structural narrowing in no-nested-flex-grid.ts.
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function findReactiveNew(node: unknown): TSESTree.NewExpression | null {
  const rec = asRecord(node);
  if (!rec || typeof rec.type !== 'string') return null;
  if (rec.type === 'NewExpression') {
    const callee = asRecord(rec.callee);
    if (callee && callee.type === 'Identifier' && typeof callee.name === 'string' && REACTIVE.has(callee.name)) {
      return node as TSESTree.NewExpression;
    }
  }
  for (const key of Object.keys(rec)) {
    if (key === 'parent') continue;
    const v = rec[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        const r = findReactiveNew(c);
        if (r) return r;
      }
    } else {
      const r = findReactiveNew(v);
      if (r) return r;
    }
  }
  return null;
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow reactive forms; this repo requires signal-forms and a zod schema.' },
    schema: [],
    messages: {
      reactiveForm:
        'Component shape: reactive forms are not used here. Author the form with signal-forms and a zod schema (validateStandardSchema), not FormGroup/FormControl.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node: TSESTree.ClassDeclaration) {
        const obj = componentDecoratorObject(node);
        if (!obj) return;
        let target: TSESTree.Node | null = null;
        const imp = obj.properties.find(
          (p): p is TSESTree.Property =>
            p.type === 'Property' && !!p.key && p.key.type === 'Identifier' && p.key.name === 'imports',
        );
        if (imp && imp.value.type === 'ArrayExpression') {
          target =
            imp.value.elements.find((el) => el && el.type === 'Identifier' && el.name === 'ReactiveFormsModule') ?? null;
        }
        if (!target) target = findReactiveNew(node.body);
        if (target) context.report({ node: target, messageId: 'reactiveForm' });
      },
    };
  },
});

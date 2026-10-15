import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement, TmplAstBoundAttribute, TmplAstTextAttribute } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-ng-model.md.

export type Options = [];
export type MessageIds = 'ngModel';
export const RULE_NAME = 'no-ng-model';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an ngModel binding (template-driven forms) in a template.' },
    schema: [],
    messages: {
      ngModel:
        'Component shape: template-driven forms are not used here. Replace ngModel with a signal-form control bound via [formField].',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    const named = (arr: readonly (TmplAstBoundAttribute | TmplAstTextAttribute)[] | undefined): boolean =>
      Array.isArray(arr) && arr.some((a) => a.name === 'ngModel');
    return {
      Element(node: TmplAstElement) {
        if (named(node.inputs) || named(node.attributes)) {
          context.report({
            loc: parserServices.convertElementSourceSpanToLoc(context, node),
            messageId: 'ngModel',
          });
        }
      },
    };
  },
});

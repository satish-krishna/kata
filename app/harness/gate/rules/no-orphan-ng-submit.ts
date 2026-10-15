import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement, TmplAstBoundEvent } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-orphan-ng-submit.md.

export type Options = [];
export type MessageIds = 'orphanNgSubmit';
export const RULE_NAME = 'no-orphan-ng-submit';

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an (ngSubmit) binding; no forms module can supply the directive in this repo.' },
    schema: [],
    messages: {
      orphanNgSubmit:
        'Component shape: (ngSubmit) is dead here. NgForm/FormGroupDirective ship only with FormsModule or ' +
        'ReactiveFormsModule, and both are banned (see harness/rules/no-orphan-ng-submit.md), so Angular ' +
        "registers a DOM listener for an event nothing ever fires. Wire the submit in the class through " +
        'submit(this.form, async () => { ... }) from @angular/forms/signals, and drop (ngSubmit) from the <form>.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    const named = (arr: readonly TmplAstBoundEvent[] | undefined): boolean =>
      Array.isArray(arr) && arr.some((a) => a.name === 'ngSubmit');
    return {
      Element(node: TmplAstElement) {
        if (named(node.outputs)) {
          context.report({
            loc: parserServices.convertElementSourceSpanToLoc(context, node),
            messageId: 'orphanNgSubmit',
          });
        }
      },
    };
  },
});

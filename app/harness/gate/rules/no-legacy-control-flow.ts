import type { TmplAstTemplate } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-legacy-control-flow.md.

export type Options = [];
export type MessageIds = 'legacyControlFlow';
export const RULE_NAME = 'no-legacy-control-flow';

const STRUCTURAL = new Set(['ngIf', 'ngFor', 'ngSwitch']);
const BLOCK: Record<string, string> = { ngIf: 'if', ngFor: 'for', ngSwitch: 'switch' };

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow *ngIf/*ngFor/*ngSwitch; use native @if/@for/@switch control flow.' },
    schema: [],
    messages: {
      legacyControlFlow:
        'Template modernity: use native control flow. Replace *{{name}} with @{{block}} (for example @if (x) {} / @for (h of xs; track h.id) {}).',
    },
  },
  defaultOptions: [],
  create(context) {
    // A Template node is not an element, so the element loc helper rejects it;
    // build the loc from the node's own ParseSourceSpan (0-based line -> ESLint 1-based).
    const locOf = (node: TmplAstTemplate) => {
      const span = node.sourceSpan ?? node.startSourceSpan;
      return {
        start: { line: span.start.line + 1, column: span.start.col },
        end: { line: span.end.line + 1, column: span.end.col },
      };
    };
    const check = (node: TmplAstTemplate) => {
      const hit = (node.templateAttrs ?? []).find((a) => STRUCTURAL.has(a.name));
      if (!hit) return;
      context.report({
        loc: locOf(node),
        messageId: 'legacyControlFlow',
        data: { name: hit.name, block: BLOCK[hit.name] },
      });
    };
    return { Template: check, 'Template$1': check };
  },
});

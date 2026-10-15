import type { TSESTree } from '@typescript-eslint/utils';
import { inComponentClass } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-presentational-inject.md.

export type Options = [];
export type MessageIds = 'presentationalInject';
export const RULE_NAME = 'no-presentational-inject';

const UI_HELPERS = new Set([
  'ElementRef', 'DestroyRef', 'ChangeDetectorRef', 'Renderer2', 'NgZone', 'ViewContainerRef', 'TemplateRef',
]);
const isDataToken = (n: string): boolean => n === 'HttpClient' || (/Service$/.test(n) && !UI_HELPERS.has(n) && !n.startsWith('Hlm'));
const isUiPath = (f: string): boolean => /(^|\/)src\/app\/ui\//.test(String(f).replaceAll('\\', '/'));

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a presentational (src/app/ui/) component injecting a data service.' },
    schema: [],
    messages: {
      presentationalInject:
        'Component shape: a presentational component (src/app/ui/) must not inject {{token}}. Move data access to a container in a feature folder.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? (context.getFilename && context.getFilename()) ?? '';
    if (!isUiPath(filename)) return {};
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
          if (isDataToken(token) && inComponentClass(node)) {
            context.report({ node, messageId: 'presentationalInject', data: { token } });
          }
        }
      },
    };
  },
});

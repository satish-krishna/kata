import type { TSESTree } from '@typescript-eslint/utils';
import { componentDecoratorObject } from './component-util.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-inline-template.md.

export type Options = [];
export type MessageIds = 'inlineTemplate' | 'inlineStyles';
export const RULE_NAME = 'no-inline-template';

const isSpecFile = (filename: string): boolean => /\.spec\.ts$/.test(String(filename).replaceAll('\\', '/'));

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: { description: 'Disallow an inline template or styles in @Component; keep them in separate files.' },
    schema: [],
    messages: {
      inlineTemplate:
        'Component shape: do not inline the template. Move it to a separate .html file and use templateUrl ' +
        '(see CLAUDE.md and harness/rules/no-inline-template.md).',
      inlineStyles:
        'Component shape: do not inline component styles. Move them to a separate stylesheet and use styleUrl, ' +
        'or drop them (a component with no own styles needs no stylesheet; see harness/rules/no-inline-template.md).',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? (context.getFilename && context.getFilename()) ?? '';
    // Spec files are exempt: test-host components legitimately use inline templates.
    if (isSpecFile(filename)) return {};
    const hasKey = (p: TSESTree.ObjectLiteralElement, name: string): boolean =>
      p.type === 'Property' &&
      !!p.key &&
      ((p.key.type === 'Identifier' && p.key.name === name) || (p.key.type === 'Literal' && p.key.value === name));
    return {
      ClassDeclaration(node: TSESTree.ClassDeclaration) {
        const obj = componentDecoratorObject(node);
        if (!obj) return;
        const tpl = obj.properties.find((p) => hasKey(p, 'template'));
        if (tpl) context.report({ node: tpl, messageId: 'inlineTemplate' });
        const styles = obj.properties.find((p) => hasKey(p, 'styles'));
        if (styles) context.report({ node: styles, messageId: 'inlineStyles' });
      },
    };
  },
});

import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { PRIMITIVE_ATTRS, PRIMITIVE_ELEMENTS } from './primitive-vocabulary.ts';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-unknown-primitive.md.

export type Options = [];
export type MessageIds = 'unknownPrimitive';
export const RULE_NAME = 'no-unknown-primitive';

type Form = 'attribute' | 'element';

const ATTR_LIKE_RE = /^(hlm[A-Z]|hlm-)/;
const ELEMENT_LIKE_RE = /^hlm-/;

const camelToKebab = (name: string): string => name.replace(/([A-Z])/g, '-$1').toLowerCase();
const kebabToCamel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// If the name written in the wrong form has a real vocabulary entry in the
// OTHER form, name that entry in the report so the fix is a single
// substitution, not a guess.
function correctFormFor(name: string, form: Form): { as: Form; name: string } | null {
  if (form === 'attribute') {
    const kebab = name.startsWith('hlm-') ? name : camelToKebab(name);
    return PRIMITIVE_ELEMENTS.has(kebab) ? { as: 'element', name: kebab } : null;
  }
  const camel = kebabToCamel(name);
  return PRIMITIVE_ATTRS.has(camel) ? { as: 'attribute', name: camel } : null;
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow an hlm* attribute or element that matches no installed selector.',
    },
    schema: [],
    messages: {
      unknownPrimitive:
        'Sealed vocabulary: "{{name}}" is not an installed primitive {{form}}.{{hint}} Check ' +
        'the house-style skill and sealing-spec.md, "The vocabulary, as installed", before using ' +
        'an hlm* name.',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);

    const report = (node: TmplAstElement, name: string, form: Form) => {
      const correct = correctFormFor(name, form);
      const hint = correct
        ? form === 'attribute'
          ? ` The installed selector is the element <${correct.name}>; write it as an element, not an attribute.`
          : ` The installed selector is the attribute ${correct.name}; write it on the native element it decorates, not as an element.`
        : '';
      context.report({
        loc: parserServices.convertElementSourceSpanToLoc(context, node),
        messageId: 'unknownPrimitive',
        data: { name, form, hint },
      });
    };

    return {
      Element(node: TmplAstElement) {
        if (ELEMENT_LIKE_RE.test(node.name) && !PRIMITIVE_ELEMENTS.has(node.name)) {
          report(node, node.name, 'element');
        }
        for (const attr of node.attributes) {
          if (ATTR_LIKE_RE.test(attr.name) && !PRIMITIVE_ATTRS.has(attr.name)) {
            report(node, attr.name, 'attribute');
          }
        }
      },
    };
  },
});

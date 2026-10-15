import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-missing-composition-part.md.

export type Options = [];
export type MessageIds = 'missingCompositionPart';
export const RULE_NAME = 'no-missing-composition-part';

const REQUIRED_DESCENDANT: Record<string, string> = {
  'hlm-dialog-content': 'hlmDialogTitle',
  'hlm-sheet-content': 'hlmSheetTitle',
};

// A structural view over the template AST nodes this walk needs: an optional
// `type` discriminant (added at runtime by the angular-eslint template
// parser, not declared on the @angular/compiler classes themselves) plus
// every container-shaped field some node kind might carry. Every concrete
// TmplAst* node this rule actually receives is a structural subtype of this,
// since every field here is optional.
interface ContainerNode {
  readonly type?: string;
  readonly attributes?: readonly { readonly name: string }[];
  readonly children?: unknown;
  readonly branches?: unknown;
  readonly groups?: unknown;
  readonly cases?: unknown;
  readonly empty?: unknown;
  readonly placeholder?: unknown;
  readonly loading?: unknown;
  readonly error?: unknown;
}

const hasAttr = (node: ContainerNode, name: string): boolean =>
  (node.attributes ?? []).some((a) => a.name === name);

// Generic child accessor across every angular-eslint template AST node shape
// that can contain nested template nodes (Element/Template `children`, the
// control-flow block shapes' `children`/`branches`/`groups`/`cases`/`empty`/
// `placeholder`/`loading`/`error`), so the descendant search is not blind to
// a title placed inside an `@if` or similar.
const CONTAINER_KEYS = [
  'children',
  'branches',
  'groups',
  'cases',
  'empty',
  'placeholder',
  'loading',
  'error',
] as const;

function* childNodes(node: ContainerNode): Generator<ContainerNode> {
  for (const key of CONTAINER_KEYS) {
    const value = node[key];
    if (!value) continue;
    if (Array.isArray(value)) yield* value as ContainerNode[];
    else yield value as ContainerNode;
  }
}

function hasDescendantWithAttr(node: ContainerNode, attrName: string): boolean {
  for (const child of childNodes(node)) {
    if (!child || typeof child !== 'object') continue;
    if (child.type === 'Element' && hasAttr(child, attrName)) return true;
    if (hasDescendantWithAttr(child, attrName)) return true;
  }
  return false;
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow an overlay primitive composed without its required title.',
    },
    schema: [],
    messages: {
      missingCompositionPart:
        'Sealed composition: <{{element}}> has no descendant carrying {{requiredAttr}}. Overlays ' +
        'need a title for accessibility (spartan composition.md); add one, e.g. ' +
        '<h2 {{requiredAttr}}>Title</h2> inside it (class="sr-only" if the design hides it).',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);

    return {
      Element(node: TmplAstElement) {
        const requiredAttr = REQUIRED_DESCENDANT[node.name];
        if (!requiredAttr || hasDescendantWithAttr(node, requiredAttr)) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'missingCompositionPart',
          data: { element: node.name, requiredAttr },
        });
      },
    };
  },
});

import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-unportalled-overlay.md.

export type Options = [];
export type MessageIds = 'unportalledOverlay';
export const RULE_NAME = 'no-unportalled-overlay';

// container element -> [content element it must wrap, the portal directive
// that must carry it]. Read as: inside <hlm-select>, the <hlm-select-content>
// must sit on *hlmSelectPortal and never be a plain child.
const REQUIRED_PORTAL: Record<string, readonly [string, string]> = {
  'hlm-select': ['hlm-select-content', 'hlmSelectPortal'],
  'hlm-dialog': ['hlm-dialog-content', 'hlmDialogPortal'],
  'hlm-sheet': ['hlm-sheet-content', 'hlmSheetPortal'],
};

// Same structural view the sibling composition rule uses: an optional `type`
// discriminant added at runtime by the angular-eslint template parser, plus
// every container-shaped field a node kind might carry. Every concrete
// TmplAst* node received here is a structural subtype, since all fields are
// optional. `templateAttrs` is what a structural directive lands in once
// `*hlmSelectPortal` has been desugared into an <ng-template>.
interface ContainerNode {
  readonly type?: string;
  readonly name?: string;
  readonly templateAttrs?: readonly { readonly name: string }[];
  readonly children?: unknown;
  readonly branches?: unknown;
  readonly groups?: unknown;
  readonly cases?: unknown;
  readonly empty?: unknown;
  readonly placeholder?: unknown;
  readonly loading?: unknown;
  readonly error?: unknown;
}

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

const carriesPortal = (node: ContainerNode, portal: string): boolean =>
  (node.templateAttrs ?? []).some((a) => a.name === portal);

/**
 * Walk down from the container looking for the content element. Returns true
 * the moment one is found that is NOT wrapped in a template carrying the
 * portal directive.
 *
 * The search deliberately looks DOWNWARD rather than at ancestors. `*hlmSelectPortal`
 * desugars to `<ng-template hlmSelectPortal><hlm-select-content>...</hlm-select-content></ng-template>`,
 * so a correctly-composed content element is a child of a Template node, and an
 * incorrectly-composed one is a plain child of the container. Both shapes are
 * visible from the container without needing parent pointers, which the
 * angular-eslint template visitor does not provide.
 */
function hasUnportalledContent(node: ContainerNode, content: string, portal: string): boolean {
  for (const child of childNodes(node)) {
    if (!child || typeof child !== 'object') continue;

    // A template carrying the portal is the correct shape. Its subtree is
    // satisfied by construction, so do not descend into it looking for more.
    if (child.type === 'Template' && carriesPortal(child, portal)) continue;

    if (child.type === 'Element' && child.name === content) return true;
    if (hasUnportalledContent(child, content, portal)) return true;
  }
  return false;
}

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow an overlay content element rendered inline instead of on its portal.',
    },
    schema: [],
    messages: {
      unportalledOverlay:
        'Sealed composition: <{{content}}> inside <{{container}}> is not on *{{portal}}. The portal is ' +
        'what registers the content template with the overlay; without it the overlay can never open, ' +
        'and the content renders inline as permanently-visible DOM. Write ' +
        '<{{content}} *{{portal}}> (see harness/rules/no-unportalled-overlay.md).',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);

    return {
      Element(node: TmplAstElement) {
        const required = REQUIRED_PORTAL[node.name];
        if (!required) return;
        const [content, portal] = required;
        if (!hasUnportalledContent(node as unknown as ContainerNode, content, portal)) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'unportalledOverlay',
          data: { container: node.name, content, portal },
        });
      },
    };
  },
});

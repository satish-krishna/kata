import { getTemplateParserServices } from '@angular-eslint/utils';
import type { TmplAstElement } from '@angular-eslint/bundled-angular-compiler';
import { createRule } from './create-rule.ts';

// What this forbids, why, and its known blind spots: see
// ../../rules/no-raw-control.md.

export type Options = [];
export type MessageIds = 'rawControl';
export const RULE_NAME = 'no-raw-control';

const CONTROL_PRIMITIVE_ATTRS: Record<string, readonly string[]> = {
  button: [
    'hlmBtn',
    'hlmDialogTrigger',
    'hlmDialogTriggerFor',
    'hlmDialogClose',
    'hlmSheetTrigger',
    'hlmSheetClose',
    'hlmSidebarTrigger',
    'hlmSidebarRail',
    'hlmSidebarMenuButton',
    'hlmSidebarMenuSubButton',
    'hlmSidebarMenuAction',
    'hlmSidebarGroupAction',
    'hlmSidebarGroupLabel',
    'hlmTabsTrigger'
  ],
  input: ['hlmInput', 'hlmSidebarInput'],
  textarea: ['hlmTextarea'],
  label: ['hlmLabel', 'hlmFieldLabel'],
  fieldset: ['hlmFieldSet'],
  legend: ['hlmFieldLegend'],
  table: ['hlmTable'],
  thead: ['hlmTableHeader', 'hlmTHead'],
  tbody: ['hlmTableBody', 'hlmTBody'],
  tfoot: ['hlmTableFooter', 'hlmTFoot'],
  tr: ['hlmTableRow', 'hlmTr'],
  th: ['hlmTableHead', 'hlmTh'],
  td: ['hlmTableCell', 'hlmTd'],
  caption: ['hlmTableCaption', 'hlmCaption'],
};

const REPLACEMENT_ONLY: Record<string, string> = {
  select: 'hlm-select',
  dialog: 'hlm-dialog',
};

export default createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a native control element where a spartan primitive exists.',
    },
    schema: [],
    messages: {
      rawControl: 'Sealed vocabulary: <{{element}}> {{guidance}}',
    },
  },
  defaultOptions: [],
  create(context) {
    const parserServices = getTemplateParserServices(context);
    return {
      Element(node: TmplAstElement) {
        const replacement = REPLACEMENT_ONLY[node.name];
        if (replacement) {
          context.report({
            loc: parserServices.convertElementSourceSpanToLoc(context, node),
            messageId: 'rawControl',
            data: {
              element: node.name,
              guidance: `has no primitive attribute. Replace it with <${replacement}> instead of a raw control.`,
            },
          });
          return;
        }

        const acceptable = CONTROL_PRIMITIVE_ATTRS[node.name];
        if (!acceptable) return;
        const hasPrimitive = node.attributes.some((a) => acceptable.includes(a.name));
        if (hasPrimitive) return;
        context.report({
          loc: parserServices.convertElementSourceSpanToLoc(context, node),
          messageId: 'rawControl',
          data: {
            element: node.name,
            guidance: `must use the spartan primitive. Add one of ${acceptable.join(', ')} (for example <${node.name} ${acceptable[0]}>) instead of a raw control.`,
          },
        });
      },
    };
  },
});

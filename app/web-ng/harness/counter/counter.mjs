// The independent structural counter (Part 1).
//
// This is one of the two engines that encode the sealing spec
// (see ../sealing-spec.md). It shares NO code with the gate. The gate parses
// templates with angular-eslint; this counter parses them with Angular's own
// compiler (@angular/compiler parseTemplate) and extracts inline templates with
// the TypeScript compiler API. Two engines, one spec: that independence is what
// closes the circularity objection, so keep it that way. Do not import anything
// the gate imports here.

import { parseTemplate } from '@angular/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// The vocabulary, mirrored from ../sealing-spec.md ("The vocabulary, as
// installed"). Read from source when the primitive set changes; do not let
// this drift from what libs/ui actually ships. `ng-icon` is deliberately NOT
// a primitive (see the spec) - it gets its own rule, rule 4, instead.
const PRIMITIVE_ATTRS = new Set([
  'hlmBtn',
  'hlmInput',
  'hlmTextarea',
  'hlmLabel',
  'hlmSeparator',
  'hlmSkeleton',
  'hlmBadge',
  'hlmTooltip',
  'hlmCard',
  'hlmCardHeader',
  'hlmCardFooter',
  'hlmCardTitle',
  'hlmCardDescription',
  'hlmCardContent',
  'hlmCardAction',
  'hlmTable',
  'hlmTableContainer',
  'hlmTHead',
  'hlmTBody',
  'hlmTFoot',
  'hlmTr',
  'hlmTh',
  'hlmTd',
  'hlmCaption',
  'hlmTableHeader',
  'hlmTableBody',
  'hlmTableFooter',
  'hlmTableRow',
  'hlmTableHead',
  'hlmTableCell',
  'hlmTableCaption',
  'hlmField',
  'hlmFieldContent',
  'hlmFieldDescription',
  'hlmFieldGroup',
  'hlmFieldLabel',
  'hlmFieldTitle',
  'hlmFieldSet',
  'hlmFieldLegend',
  'hlmSelect',
  'hlmSelectGroup',
  'hlmSelectLabel',
  'hlmSelectMultiple',
  'hlmSelectPlaceholder',
  'hlmSelectPortal',
  'hlmSelectSeparator',
  'hlmSelectValue',
  'hlmSelectValues',
  'hlmSelectValuesContent',
  'hlmSelectValueTemplate',
  'hlmDialogClose',
  'hlmDialogDescription',
  'hlmDialogFooter',
  'hlmDialogHeader',
  'hlmDialogOverlay',
  'hlmDialogPortal',
  'hlmDialogTitle',
  'hlmDialogTrigger',
  'hlmDialogTriggerFor',
  'hlmSheetClose',
  'hlmSheetDescription',
  'hlmSheetFooter',
  'hlmSheetHeader',
  'hlmSheetOverlay',
  'hlmSheetPortal',
  'hlmSheetTitle',
  'hlmSheetTrigger',
  'hlmTabs',
  'hlmTabsContent',
  'hlmTabsContentLazy',
  'hlmTabsList',
  'hlmTabsTrigger',
  'hlmAvatarBadge',
  'hlmAvatarFallback',
  'hlmAvatarGroup',
  'hlmAvatarGroupCount',
  'hlmAvatarImage',
  'hlmSwitchThumb',
  'hlmSidebarContent',
  'hlmSidebarFooter',
  'hlmSidebarGroup',
  'hlmSidebarGroupAction',
  'hlmSidebarGroupContent',
  'hlmSidebarGroupLabel',
  'hlmSidebarHeader',
  'hlmSidebarInput',
  'hlmSidebarInset',
  'hlmSidebarMenu',
  'hlmSidebarMenuAction',
  'hlmSidebarMenuBadge',
  'hlmSidebarMenuButton',
  'hlmSidebarMenuItem',
  'hlmSidebarMenuSkeleton',
  'hlmSidebarMenuSub',
  'hlmSidebarMenuSubButton',
  'hlmSidebarMenuSubItem',
  'hlmSidebarRail',
  'hlmSidebarSeparator',
  'hlmSidebarTrigger',
  'hlmSidebarWrapper',
]);
const PRIMITIVE_ELEMENTS = new Set([
  'hlm-card',
  'hlm-card-header',
  'hlm-card-footer',
  'hlm-badge',
  'hlm-separator',
  'hlm-skeleton',
  'hlm-avatar',
  'hlm-avatar-badge',
  'hlm-avatar-group',
  'hlm-avatar-group-count',
  'hlm-field',
  'hlm-field-content',
  'hlm-field-description',
  'hlm-field-error',
  'hlm-field-group',
  'hlm-field-label',
  'hlm-field-separator',
  'hlm-field-title',
  'hlm-select',
  'hlm-select-content',
  'hlm-select-group',
  'hlm-select-item',
  'hlm-select-label',
  'hlm-select-multiple',
  'hlm-select-placeholder',
  'hlm-select-scroll-down',
  'hlm-select-scroll-up',
  'hlm-select-separator',
  'hlm-select-trigger',
  'hlm-select-value',
  'hlm-select-values-content',
  'hlm-dialog',
  'hlm-dialog-content',
  'hlm-dialog-footer',
  'hlm-dialog-header',
  'hlm-dialog-overlay',
  'hlm-sheet',
  'hlm-sheet-content',
  'hlm-sheet-footer',
  'hlm-sheet-header',
  'hlm-sheet-overlay',
  'hlm-tabs',
  'hlm-tabs-list',
  'hlm-paginated-tabs-list',
  'hlm-switch',
  'hlm-sidebar',
  'hlm-sidebar-content',
  'hlm-sidebar-footer',
  'hlm-sidebar-group',
  'hlm-sidebar-header',
  'hlm-sidebar-menu-badge',
  'hlm-sidebar-menu-skeleton',
  'hlm-sidebar-separator',
  'hlm-sidebar-wrapper',
]);

// Rule 1's table: a native element -> the set of acceptable primitive
// attributes, any one of which satisfies the rule (spec: "The four rules", 1).
const CONTROL_PRIMITIVE_ATTRS = {
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

// Rule 1's replacement-only table: no attribute makes the native element
// acceptable, so the element itself is the violation.
const REPLACEMENT_ONLY = { select: 'hlm-select', dialog: 'hlm-dialog' };

// The namespaced node name @angular/compiler gives an inline <svg> (spec:
// "What each engine parses").
const SVG_ELEMENT = ':svg:svg';

// Rule 5's name-shape regexes (spec: "unknown-primitive"). An attribute in
// either casing, or an element in kebab form, that looks like the hlm
// namespace but matches no installed selector in that exact form.
const UNKNOWN_ATTR_CAMEL_RE = /^hlm[A-Z]/;
const UNKNOWN_ATTR_KEBAB_RE = /^hlm-/;
const UNKNOWN_ELEMENT_RE = /^hlm-/;

// Rule 6's required-descendant table: a container primitive that must have a
// descendant carrying the named attribute (spec: "missing-composition-part").
const REQUIRED_DESCENDANT = {
  'hlm-dialog-content': 'hlmDialogTitle',
  'hlm-sheet-content': 'hlmSheetTitle',
};

const emptyTotals = () => ({
  'raw-control': 0,
  'appearance-on-primitive': 0,
  'style-attribute': 0,
  'raw-icon': 0,
  'unknown-primitive': 0,
  'missing-composition-part': 0,
  all: 0,
});

const norm = (p) => p.replaceAll('\\', '/');

// Static class attribute tokens. Dynamic [class]/[ngClass] bindings are out of
// scope: Angular's baseline CLAUDE.md endorses class bindings, and their values
// are not statically decidable here.
function classTokens(el) {
  const attr = el.attributes.find((a) => a.name === 'class');
  return attr && typeof attr.value === 'string' ? attr.value.split(/\s+/).filter(Boolean) : [];
}

// Strip responsive/state prefixes (sm:, hover:, dark:, ...) to the base utility.
const baseUtil = (t) => (t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t);

// Appearance = color, typography, decoration, and internal padding. Layout,
// spacing (margin/gap), dimensions, and position are NOT appearance and are
// allowed on a primitive, per spartan's "class is for layout only".
const APPEARANCE_RE =
  /^(bg-|text-(?!left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$)|font-|leading-|tracking-|border($|-)|rounded($|-)|shadow($|-)|ring($|-)|p[xytblrse]?-)/;
const isAppearance = (t) => APPEARANCE_RE.test(baseUtil(t));

// Rule 6 helper: does the subtree rooted at `nodes` contain an element
// carrying `attrName`, at any depth (a descendant, not just a direct child)?
// Mirrors walk()'s own traversal (children/branches/cases/empty) so control
// flow inside the container does not hide a composed part.
function hasDescendantWithAttr(nodes, attrName) {
  for (const n of nodes) {
    if (n && Array.isArray(n.attributes) && n.attributes.some((a) => a.name === attrName)) {
      return true;
    }
    // See the block-AST note on the main walk below: @switch exposes `groups`,
    // and @empty / @defer's sub-blocks are objects rather than arrays.
    for (const key of ['children', 'branches', 'cases', 'groups', 'empty', 'placeholder', 'loading', 'error']) {
      const v = n?.[key];
      if (Array.isArray(v)) {
        if (hasDescendantWithAttr(v, attrName)) return true;
      } else if (v && typeof v === 'object') {
        if (hasDescendantWithAttr([v], attrName)) return true;
      }
    }
  }
  return false;
}

// Rule 6 helper: does the ancestor stack contain an element carrying
function elementViolations(el, file, lineOffset) {
  const out = [];
  const attrNames = new Set(el.attributes.map((a) => a.name));
  const line = (el.sourceSpan?.start?.line ?? 0) + 1 + lineOffset;

  // Rule 1: raw-control. Two shapes: an attribute-bearing native element
  // (any one of its acceptable attributes satisfies the rule), and a
  // replacement-only native element (no attribute is acceptable - the
  // element itself is the violation).
  const acceptableAttrs = CONTROL_PRIMITIVE_ATTRS[el.name];
  if (acceptableAttrs && !acceptableAttrs.some((a) => attrNames.has(a))) {
    out.push({
      kind: 'raw-control',
      file,
      line,
      detail: `${el.name} without ${acceptableAttrs.join('/')}`,
    });
  }
  const replacement = REPLACEMENT_ONLY[el.name];
  if (replacement) {
    out.push({
      kind: 'raw-control',
      file,
      line,
      detail: `${el.name} has no acceptable attribute, replace with ${replacement}`,
    });
  }

  const isPrimitive =
    PRIMITIVE_ELEMENTS.has(el.name) || [...attrNames].some((n) => PRIMITIVE_ATTRS.has(n));

  // Rule 2: appearance-on-primitive. Layout classes on a primitive are fine;
  // only an appearance-override class is a violation.
  if (isPrimitive) {
    const offender = classTokens(el).find(isAppearance);
    if (offender) {
      out.push({
        kind: 'appearance-on-primitive',
        file,
        line,
        detail: `appearance class ${offender} on primitive ${el.name}`,
      });
    }
  }

  // Rule 3: style-attribute (a static inline style literal, any element). A
  // [style.x] binding is allowed; Angular's baseline doc endorses style bindings.
  if (el.attributes.some((a) => a.name === 'style')) {
    out.push({ kind: 'style-attribute', file, line, detail: `static style attribute on ${el.name}` });
  }

  // Rule 4: raw-icon. A raw inline <svg>; @angular/compiler namespaces the
  // node name to ":svg:svg" (spec: "What each engine parses"). This does not
  // (and cannot, from a template alone) check the provideIcons registration -
  // the spec states that half is doc-only.
  if (el.name === SVG_ELEMENT) {
    out.push({ kind: 'raw-icon', file, line, detail: 'inline <svg> element; use <ng-icon>' });
  }

  // Rule 5: unknown-primitive. A closed-world check: an hlm-shaped attribute
  // or element name that matches no installed selector IN THAT FORM. The
  // attribute-vs-element distinction is the point (spec: "unknown-primitive").
  for (const a of el.attributes) {
    if (
      (UNKNOWN_ATTR_CAMEL_RE.test(a.name) || UNKNOWN_ATTR_KEBAB_RE.test(a.name)) &&
      !PRIMITIVE_ATTRS.has(a.name)
    ) {
      out.push({
        kind: 'unknown-primitive',
        file,
        line,
        detail: `unknown hlm attribute ${a.name} on ${el.name}`,
      });
    }
  }
  if (UNKNOWN_ELEMENT_RE.test(el.name) && !PRIMITIVE_ELEMENTS.has(el.name)) {
    out.push({ kind: 'unknown-primitive', file, line, detail: `unknown hlm element ${el.name}` });
  }

  // Rule 6: missing-composition-part. A primitive present but not composed:
  // an overlay container missing the descendant that carries its accessible
  // name. See ../sealing-spec.md, "What this rule deliberately does NOT check":
  // the field-wrapping half of spartan's forms doc is doc-only, not gated,
  // because the repo's own conformance target calls for a toolbar search input
  // and a filter select, neither of which is a form field.
  const requiredDescendantAttr = REQUIRED_DESCENDANT[el.name];
  if (requiredDescendantAttr && !hasDescendantWithAttr(el.children ?? [], requiredDescendantAttr)) {
    out.push({
      kind: 'missing-composition-part',
      file,
      line,
      detail: `${el.name} without a descendant carrying ${requiredDescendantAttr}`,
    });
  }

  return out;
}

// Duck-typed AST walk. An element node has a string name plus attributes and
// inputs arrays; block nodes carry their bodies under the keys listed below.
function walk(nodes, file, lineOffset, acc) {
  for (const n of nodes) {
    const isElement =
      n && typeof n.name === 'string' && Array.isArray(n.attributes) && Array.isArray(n.inputs);
    if (isElement) {
      acc.push(...elementViolations(n, file, lineOffset));
    }
    // Angular block-AST child keys, verified against @angular/compiler: a
    // SwitchBlock exposes `groups` (NOT `cases`; the group then carries both),
    // and ForLoopBlock.empty plus DeferredBlock.placeholder/loading/error are
    // OBJECTS rather than arrays. The original list was children/branches/
    // cases/empty guarded on Array.isArray, so it descended into no @switch,
    // @empty or @defer body at all: violations inside them went uncounted, and
    // the gate, which does walk them, silently disagreed.
    for (const key of ['children', 'branches', 'cases', 'groups', 'empty', 'placeholder', 'loading', 'error']) {
      const v = n?.[key];
      if (Array.isArray(v)) walk(v, file, lineOffset, acc);
      else if (v && typeof v === 'object') walk([v], file, lineOffset, acc);
    }
  }
}

export function countTemplateSource(template, { file, lineOffset = 0 }) {
  const { nodes } = parseTemplate(template, file, { preserveWhitespaces: false });
  const acc = [];
  walk(nodes, file, lineOffset, acc, []);
  return acc;
}

// Pull every inline `template: \`...\`` string out of a component .ts, with the
// 0-based file line of the literal's opening backtick as the line offset.
function extractInlineTemplates(sourceText) {
  const sf = ts.createSourceFile('component.ts', sourceText, ts.ScriptTarget.Latest, true);
  const results = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      node.name.getText(sf) === 'template' &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isStringLiteral(node.initializer))
    ) {
      const init = node.initializer;
      const { line } = sf.getLineAndCharacterOfPosition(init.getStart(sf));
      results.push({ text: init.text, lineOffset: line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return results;
}

export function countFile(absPath, { root } = {}) {
  const file = root ? norm(relative(root, absPath)) : norm(absPath);
  const text = readFileSync(absPath, 'utf8');
  if (absPath.endsWith('.html')) {
    return countTemplateSource(text, { file, lineOffset: 0 });
  }
  if (absPath.endsWith('.ts')) {
    const acc = [];
    for (const { text: tpl, lineOffset } of extractInlineTemplates(text)) {
      acc.push(...countTemplateSource(tpl, { file, lineOffset }));
    }
    return acc;
  }
  return [];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', 'coverage']);

// Recursively collect template-bearing files under a directory.
export function collectTemplateFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...collectTemplateFiles(full));
    } else if (entry.endsWith('.html') || entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function tally(paths, opts = {}) {
  const files = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) files.push(...collectTemplateFiles(p));
    else files.push(p);
  }
  const violations = [];
  for (const f of files) violations.push(...countFile(f, opts));

  violations.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  const totals = emptyTotals();
  for (const v of violations) {
    totals[v.kind] += 1;
    totals.all += 1;
  }
  return { totals, violations };
}

// CLI: node counter.mjs [--root <dir>] <path...>  ->  JSON tally on stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let root;
  const ri = args.indexOf('--root');
  if (ri >= 0) {
    root = args[ri + 1];
    args.splice(ri, 2);
  }
  if (args.length === 0) {
    process.stderr.write('usage: node counter.mjs [--root <dir>] <file-or-dir...>\n');
    process.exit(2);
  }
  const result = tally(args, { root });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Shared helpers for the Part 3 component-shape TS rules. Gate-internal only:
// this is shared among the gate's own rules, never with the counter (the two
// engines stay independent). Operates on typescript-eslint's ESTree AST.

import type { TSESTree } from '@typescript-eslint/utils';

type ComponentClassNode = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

export function hasComponentDecorator(classNode: ComponentClassNode): boolean {
  const decs = classNode.decorators ?? [];
  return decs.some((d) => {
    const e = d.expression;
    const callee = e && e.type === 'CallExpression' ? e.callee : e;
    return callee && callee.type === 'Identifier' && callee.name === 'Component';
  });
}

export function inComponentClass(node: TSESTree.Node): boolean {
  let p: TSESTree.Node | undefined = node.parent;
  while (p) {
    if ((p.type === 'ClassDeclaration' || p.type === 'ClassExpression') && hasComponentDecorator(p)) return true;
    p = p.parent;
  }
  return false;
}

export function componentDecoratorObject(classNode: ComponentClassNode): TSESTree.ObjectExpression | null {
  for (const d of classNode.decorators ?? []) {
    const e = d.expression;
    if (e && e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'Component') {
      const arg = e.arguments[0];
      if (arg && arg.type === 'ObjectExpression') return arg;
    }
  }
  return null;
}

// --- MVVM helpers (rules 7-10) ---------------------------------------------
// Shared by the four MVVM rules, and kept alongside the rule-5 helpers above so
// the path/name conventions stay in one place even though rule 5 itself is left
// untouched (its own local copies keep it independent and its tests unchanged).

// The path split rule 5 keys on, and rules 8/9 key on the complement of.
export function isUiPath(filename: string): boolean {
  return /(^|\/)src\/app\/ui\//.test(String(filename).replaceAll('\\', '/'));
}

// Rule 5's UI-helper allowlist, reused by rule 9 (feature-injects-data), which
// is rule 5's inject check inverted across the ui/ path split.
const UI_HELPERS = new Set([
  'ElementRef', 'DestroyRef', 'ChangeDetectorRef', 'Renderer2', 'NgZone', 'ViewContainerRef', 'TemplateRef',
]);

export function isDataServiceToken(name: string): boolean {
  return name === 'HttpClient' || (/Service$/.test(name) && !UI_HELPERS.has(name) && !name.startsWith('Hlm'));
}

// A ViewModel is identified syntactically by a class-name suffix, exactly as
// rule 5 promoted the `Service` suffix to a decidable marker.
export function isViewModelName(name: string | null | undefined): boolean {
  return typeof name === 'string' && /ViewModel$/.test(name);
}

// Rule 2's first widening (component-shape-spec.md, "Two widenings the capstone
// forced"): component-subscribe now fires inside @Component classes AND inside
// classes whose name ends in ViewModel, reusing the same marker as rule 7. The
// capstone found the gate relocating the hand-managed subscribe into the one
// class rule 2's original scope note exempted, so the predicate now covers both.
export function inComponentOrViewModelClass(node: TSESTree.Node): boolean {
  let p: TSESTree.Node | undefined = node.parent;
  while (p) {
    if (p.type === 'ClassDeclaration' || p.type === 'ClassExpression') {
      if (hasComponentDecorator(p) || isViewModelName(p.id && p.id.name)) return true;
    }
    p = p.parent;
  }
  return false;
}

// Generalizes componentDecoratorObject to an arbitrary set of decorator names
// (rule 7 needs @Injectable or @Service, not @Component).
export function decoratorObjectByNames(
  classNode: ComponentClassNode,
  names: readonly string[],
): TSESTree.ObjectExpression | null {
  for (const d of classNode.decorators ?? []) {
    const e = d.expression;
    if (e && e.type === 'CallExpression' && e.callee.type === 'Identifier' && names.includes(e.callee.name)) {
      const arg = e.arguments[0];
      if (arg && arg.type === 'ObjectExpression') return arg;
    }
  }
  return null;
}

// Like inComponentClass, but returns the enclosing @Component class node
// itself (rule 10 needs to inspect that class's own providers array).
export function nearestComponentClass(node: TSESTree.Node): ComponentClassNode | null {
  let p: TSESTree.Node | undefined = node.parent;
  while (p) {
    if ((p.type === 'ClassDeclaration' || p.type === 'ClassExpression') && hasComponentDecorator(p)) return p;
    p = p.parent;
  }
  return null;
}

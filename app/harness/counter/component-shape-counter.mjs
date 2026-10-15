// The independent component-shape counter (Part 3).
//
// Second of the two engines that encode the component-shape spec
// (see ../component-shape-spec.md). It shares NO code with the gate. The gate
// uses typescript-eslint's ESTree AST (and angular-eslint for the ngModel rule);
// this counter walks the TypeScript compiler's own AST (ts.createSourceFile) and
// parses templates with @angular/compiler's parseTemplate. Two engines, one
// spec: that independence is what closes the circularity objection, so keep it
// that way. Do not import anything the gate imports here.

import { parseTemplate } from '@angular/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const norm = (p) => p.replaceAll('\\', '/');

// The fourteen gated kinds contribute to totals.all; the two heuristics are
// measured and reported but excluded from all, so all counts what the gate
// could have blocked.
const GATED_KINDS = [
  'hand-set-change-detection',
  'component-subscribe',
  'template-driven-form',
  'restated-validator',
  'presentational-injects-data',
  'reactive-form',
  'vm-not-component-scoped',
  'state-outside-vm',
  'feature-injects-data',
  'vm-not-provided',
  'explicit-standalone',
  'legacy-icon-module',
  'unregistered-icon',
  'orphan-ng-submit',
];
const HEURISTIC_KINDS = ['hand-written-form-model', 'dumb-holds-state'];
const isGated = (k) => GATED_KINDS.includes(k);

const emptyTotals = () => {
  const t = {};
  for (const k of [...GATED_KINDS, ...HEURISTIC_KINDS]) t[k] = 0;
  t.all = 0;
  return t;
};

// Signal-forms per-field validators that duplicate a rule the zod schema owns.
// validateStandardSchema is the blessed path; validate/validateAsync/validateHttp/
// validateTree express logic a schema cannot own and are not flagged.
const RESTATED_VALIDATORS = new Set(['required', 'minLength', 'maxLength', 'min', 'max', 'email', 'pattern']);

// inject()-able tokens that are presentation infrastructure, allowed in a ui/ component.
const UI_HELPER_TOKENS = new Set([
  'ElementRef', 'DestroyRef', 'ChangeDetectorRef', 'Renderer2', 'NgZone', 'ViewContainerRef', 'TemplateRef',
]);
const REACTIVE_SYMBOLS = new Set(['FormGroup', 'FormControl', 'FormBuilder', 'FormArray']);

// Rule 8 (state-outside-vm): the reactive-state constructors that a feature
// component may not hold itself. input()/output()/model()/viewChild()/contentChild()/
// inject()/toSignal() are deliberately not in this set: component API and edge
// conversions, not screen state. `form` was added by the capstone widening; it
// only counts when resolved as an import from @angular/forms/signals (checked
// separately below), unlike the bare-identifier match used for signal/computed/
// linkedSignal.
const STATE_CTORS = new Set(['signal', 'computed', 'linkedSignal']);
const STATE_FORM_CTOR = 'form';

const isUiPath = (file) => /(^|\/)src\/app\/ui\//.test(norm(file));
const isDataToken = (name) =>
  name === 'HttpClient' || (/Service$/.test(name) && !UI_HELPER_TOKENS.has(name) && !name.startsWith('Hlm'));
// A *ViewModel identifier is never a *Service identifier (checked above), and a
// ViewModel is identified purely by this name suffix, per the house-style skill.
const isViewModel = (name) => /ViewModel$/.test(name);

function getDecorators(node) {
  if (typeof ts.getDecorators === 'function' && ts.canHaveDecorators?.(node)) {
    return ts.getDecorators(node) ?? [];
  }
  return node.decorators ?? [];
}

// --- TypeScript source: the five class-level kinds plus the three heuristics ---

export function countTsSource(sourceText, { file }) {
  const sf = ts.createSourceFile('component.ts', sourceText, ts.ScriptTarget.Latest, true);
  const out = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const ui = isUiPath(file);

  // Imports: which per-field validators came from @angular/forms/signals, and
  // whether `form` itself was imported from there (rule 8's widening resolves
  // `form` as an import, unlike the bare-identifier match used for signal/
  // computed/linkedSignal).
  const signalsValidators = new Set();
  // LOCAL names bound to the signals-forms `form` export (an import may be
  // aliased, in which case the call site uses the alias).
  const formLocalNames = new Set();
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === '@angular/forms/signals' &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    ) {
      for (const el of st.importClause.namedBindings.elements) {
        // propertyName is the ORIGINAL export when the import is aliased; name
        // is always the local binding the call site actually uses. Matching on
        // the local name alone misses `import { form as f }`, which the gate
        // resolves: a two-engine disagreement the pre-merge review found and
        // which no fixture covered.
        const original = el.propertyName ? el.propertyName.text : el.name.text;
        const local = el.name.text;
        if (RESTATED_VALIDATORS.has(original)) signalsValidators.add(local);
        if (original === STATE_FORM_CTOR) formLocalNames.add(local);
      }
    }
  }

  // Local type names (interface / type alias), used by the hand-written-model heuristic.
  const localTypeNames = new Set();
  const collectTypes = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      localTypeNames.add(node.name.text);
    }
    ts.forEachChild(node, collectTypes);
  };
  collectTypes(sf);

  const componentCall = (classNode) => {
    for (const dec of getDecorators(classNode)) {
      const expr = dec.expression;
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Component') {
        return expr;
      }
    }
    return null;
  };

  const decoratorObject = (call) =>
    call.arguments.length && ts.isObjectLiteralExpression(call.arguments[0]) ? call.arguments[0] : null;

  // Key comparison strips quotes, so `{ standalone: true }` and
  // `{ 'standalone': true }` are the same property. getText() alone returns the
  // literal WITH its quotes, which made the quoted form invisible here while the
  // gate (which reads the Literal's value) still saw it: a two-engine
  // disagreement found by the pre-merge review, not by any test.
  const propKeyName = (p) => {
    if (!p.name) return null;
    if (ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isStringLiteral(p.name) || ts.isNoSubstitutionTemplateLiteral(p.name)) return p.name.text;
    return p.name.getText(sf);
  };
  const findProp = (obj, name) =>
    obj.properties.find((p) => ts.isPropertyAssignment(p) && propKeyName(p) === name) ?? null;

  const visitClass = (classNode) => {
    const call = componentCall(classNode);
    if (!call) return; // only @Component classes are in scope
    const obj = decoratorObject(call);
    let reactiveLine = null; // reactive-form is flagged once per component (import or new-expression)

    // Decorator-level kinds.
    if (obj) {
      const cd = findProp(obj, 'changeDetection');
      if (cd) out.push({ kind: 'hand-set-change-detection', file, line: lineOf(cd), detail: 'changeDetection set explicitly' });

      // Rule 11 (explicit-standalone): same AST shape as rule 1, a property key
      // present in the decorator's object literal, to any value.
      const sa = findProp(obj, 'standalone');
      if (sa) out.push({ kind: 'explicit-standalone', file, line: lineOf(sa), detail: 'standalone set explicitly' });

      const imp = findProp(obj, 'imports');
      if (imp && ts.isArrayLiteralExpression(imp.initializer)) {
        for (const el of imp.initializer.elements) {
          if (ts.isIdentifier(el) && el.text === 'FormsModule') {
            out.push({ kind: 'template-driven-form', file, line: lineOf(el), detail: 'FormsModule in imports' });
          }
          if (ts.isIdentifier(el) && el.text === 'ReactiveFormsModule') {
            reactiveLine ??= lineOf(el);
          }
          // Rule 12 (legacy-icon-module): same AST shape as the FormsModule/
          // ReactiveFormsModule checks above.
          if (ts.isIdentifier(el) && el.text === 'NgIconsModule') {
            out.push({ kind: 'legacy-icon-module', file, line: lineOf(el), detail: 'NgIconsModule in imports' });
          }
        }
      }
    }

    // Rule 10 (vm-not-provided) reads this component's own `providers` array.
    // `providers: [...spread]` is not resolvable statically and is treated as
    // satisfying the rule, a stated blind spot rather than a guess.
    const providedNames = new Set();
    let providersHasSpread = false;
    const prov = obj ? findProp(obj, 'providers') : null;
    if (prov && ts.isArrayLiteralExpression(prov.initializer)) {
      for (const el of prov.initializer.elements) {
        if (ts.isIdentifier(el)) providedNames.add(el.text);
        if (ts.isSpreadElement(el)) providersHasSpread = true;
      }
    }
    // Rule 13 is NOT here. It was drafted as a per-component check (NgIcon in
    // imports without provideIcons in providers) and that was wrong: spartan's
    // icons doc says "provided to the component (or app)", and app-level
    // registration is a documented pattern under which a correct component has
    // no provideIcons of its own. The draft fired on exactly the capstone
    // builds whose icons worked. It is now a file-level check, below.
    const injectedViewModels = []; // { token, line } for inject(XViewModel) calls

    // Member-level kinds: walk the class members only, so the decorator is not re-scanned.
    let hasFormCall = false;
    const modelSignals = []; // signal<LocalType>() nodes
    // Rule 8: a signal()/computed()/linkedSignal() property that is itself the
    // model argument of a form(...) built in this same class is part of that
    // form's own reactive state tree, not a second piece of state, so it must
    // not be double counted alongside the form() hit. Candidates are collected
    // here and resolved once the whole class has been walked, because the
    // form(...) call establishing that link can appear textually before or
    // after the candidate property.
    const stateSignalCandidates = []; // { name, ctorText, line }
    const formModelNames = new Set();

    const walk = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // .subscribe(...)
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'subscribe') {
          out.push({ kind: 'component-subscribe', file, line: lineOf(node), detail: '.subscribe in a component' });
        }
        // inject(Token)
        if (ts.isIdentifier(callee) && callee.text === 'inject' && node.arguments.length && ts.isIdentifier(node.arguments[0])) {
          const token = node.arguments[0].text;
          if (ui && isDataToken(token)) {
            out.push({ kind: 'presentational-injects-data', file, line: lineOf(node), detail: `inject(${token}) in a ui/ component` });
          }
          // Rule 9: rule 5 inverted across the path split. A feature component
          // (NOT under ui/) may not inject a data service directly either;
          // its ViewModel should. ActivatedRoute/Router and a *ViewModel
          // identifier never match isDataToken, so they fall through here.
          if (!ui && isDataToken(token)) {
            out.push({ kind: 'feature-injects-data', file, line: lineOf(node), detail: `inject(${token}) in a feature component` });
          }
          // Rule 10: remember every injected ViewModel so we can check, once the
          // whole class has been walked, whether it was also provided.
          if (isViewModel(token)) {
            injectedViewModels.push({ token, line: lineOf(node) });
          }
        }
        // per-field validator restating a schema rule
        if (ts.isIdentifier(callee) && signalsValidators.has(callee.text)) {
          out.push({ kind: 'restated-validator', file, line: lineOf(node), detail: `${callee.text}() restates a schema rule` });
        }
        // form(...) marks that a form is authored here. When `form` resolves
        // to @angular/forms/signals, its first argument is the model signal
        // that form wraps; remember its name so rule 8 does not also flag that
        // signal as a second, separate piece of state (see stateSignalCandidates).
        if (ts.isIdentifier(callee) && callee.text === 'form') {
          hasFormCall = true;
          if (formLocalNames.has(callee.text) && node.arguments.length) {
            const arg = node.arguments[0];
            if (ts.isIdentifier(arg)) {
              formModelNames.add(arg.text);
            } else if (
              ts.isPropertyAccessExpression(arg) &&
              arg.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
              formModelNames.add(arg.name.text);
            }
          }
        }
        // signal<LocalType>(...) is a candidate hand-written model
        if (ts.isIdentifier(callee) && callee.text === 'signal' && node.typeArguments?.length) {
          const ta = node.typeArguments[0];
          if (ts.isTypeReferenceNode(ta) && ts.isIdentifier(ta.typeName) && localTypeNames.has(ta.typeName.text)) {
            modelSignals.push({ node, type: ta.typeName.text });
          }
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && REACTIVE_SYMBOLS.has(node.expression.text)) {
        reactiveLine ??= lineOf(node);
      }
      // dumb-holds-state: a writable signal() field in a ui/ component (not input/model).
      if (ui && ts.isPropertyDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const init = node.initializer.expression;
        if (ts.isIdentifier(init) && init.text === 'signal') {
          out.push({ kind: 'dumb-holds-state', file, line: lineOf(node), detail: 'writable signal state in a ui/ component' });
        }
      }
      // Rule 8 (state-outside-vm): a feature component (NOT under ui/) declaring
      // its own signal()/computed()/linkedSignal()/form() field. Its ViewModel
      // should own that state instead. input()/output()/model()/viewChild()/
      // contentChild()/inject()/toSignal() are component API, not state, and are
      // deliberately absent from STATE_CTORS. `form` (the capstone widening)
      // only counts when it resolves to the @angular/forms/signals import.
      if (!ui && ts.isPropertyDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const init = node.initializer.expression;
        if (ts.isIdentifier(init) && STATE_CTORS.has(init.text)) {
          const name = ts.isIdentifier(node.name) ? node.name.text : null;
          stateSignalCandidates.push({ name, ctorText: init.text, line: lineOf(node) });
        } else if (ts.isIdentifier(init) && formLocalNames.has(init.text)) {
          out.push({ kind: 'state-outside-vm', file, line: lineOf(node), detail: 'form() state on a feature component' });
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const member of classNode.members) walk(member);

    // Resolve the deferred rule-8 signal candidates now that every form(...)
    // call in the class has been seen: a candidate consumed as a form's model
    // is that form's own state, not a second violation.
    for (const c of stateSignalCandidates) {
      if (c.name && formModelNames.has(c.name)) continue;
      out.push({ kind: 'state-outside-vm', file, line: c.line, detail: `${c.ctorText}() state on a feature component` });
    }

    if (hasFormCall) {
      for (const m of modelSignals) {
        out.push({ kind: 'hand-written-form-model', file, line: lineOf(m.node), detail: `signal<${m.type}> model instead of z.infer` });
      }
    }
    if (reactiveLine !== null) {
      out.push({ kind: 'reactive-form', file, line: reactiveLine, detail: 'reactive forms (FormGroup/FormControl/ReactiveFormsModule)' });
    }
    // Rule 10: a ViewModel injected but not listed in this component's own
    // `providers`. A spread in `providers` is treated as satisfying every VM,
    // per the stated blind spot.
    if (!providersHasSpread) {
      for (const { token, line } of injectedViewModels) {
        if (!providedNames.has(token)) {
          out.push({ kind: 'vm-not-provided', file, line, detail: `inject(${token}) with no matching providers entry` });
        }
      }
    }
  };

  // Rule 7 (vm-not-component-scoped): a ViewModel-suffixed class decorated with
  // @Injectable({...}) or @Service({...}) whose metadata declares providedIn.
  // A ViewModel carries no @Component decorator, so visitClass above never
  // touches this class, and this check is independent of the ui/ path split.
  const visitViewModel = (classNode) => {
    if (!classNode.name || !isViewModel(classNode.name.text)) return;
    let call = null;
    for (const dec of getDecorators(classNode)) {
      const expr = dec.expression;
      if (
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        (expr.expression.text === 'Injectable' || expr.expression.text === 'Service')
      ) {
        call = expr;
        break;
      }
    }
    if (!call) return;
    const obj = decoratorObject(call);
    if (!obj) return;
    const p = findProp(obj, 'providedIn');
    if (p) {
      out.push({ kind: 'vm-not-component-scoped', file, line: lineOf(p), detail: 'ViewModel declares providedIn' });
    }
  };

  // Rule 2 widening (component-subscribe): the predicate now also covers
  // classes whose name ends in ViewModel, reusing rule 7's marker, because the
  // capstone found .subscribe relocated into the one class the original scope
  // note exempted. A class that is already scanned as a @Component above (rare,
  // but possible if a ViewModel-named class also carries @Component) is not
  // re-walked here to avoid double-counting.
  const visitViewModelSubscribe = (classNode) => {
    if (!classNode.name || !isViewModel(classNode.name.text)) return;
    if (componentCall(classNode)) return; // already walked by visitClass
    const walk = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'subscribe') {
          out.push({ kind: 'component-subscribe', file, line: lineOf(node), detail: '.subscribe in a ViewModel' });
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const member of classNode.members) walk(member);
  };

  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      visitClass(node);
      visitViewModel(node);
      visitViewModelSubscribe(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Rule 13, `unregistered-icon`, is a FILE-level property: glyph symbols
  // imported from @ng-icons/lucide into a file that never calls provideIcons.
  // Once per file, at the first offending import. A file relying on app-level
  // registration imports no glyph at all and is silent here; a file that
  // imports a glyph and routes it to a custom token is not.
  const lucideImports = [];
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === '@ng-icons/lucide' &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings) &&
      st.importClause.namedBindings.elements.length > 0
    ) {
      lucideImports.push(st);
    }
  }
  if (lucideImports.length > 0) {
    let callsProvideIcons = false;
    const scanForProvideIcons = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'provideIcons'
      ) {
        callsProvideIcons = true;
      }
      ts.forEachChild(node, scanForProvideIcons);
    };
    scanForProvideIcons(sf);
    if (!callsProvideIcons) {
      out.push({
        kind: 'unregistered-icon',
        file,
        line: lineOf(lucideImports[0]),
        detail: 'lucide symbols imported without a provideIcons(...) registration',
      });
    }
  }

  return out;
}

// --- Templates: the ngModel half of template-driven-form, and rule 14 (orphan-ng-submit) ---

function walkTemplateForNgModel(nodes, file, lineOffset, acc) {
  const named = (arr) => Array.isArray(arr) && arr.some((a) => a.name === 'ngModel');
  for (const n of nodes) {
    if (n && typeof n.name === 'string' && Array.isArray(n.attributes) && Array.isArray(n.inputs)) {
      if (named(n.attributes) || named(n.inputs)) {
        const line = (n.sourceSpan?.start?.line ?? 0) + 1 + lineOffset;
        acc.push({ kind: 'template-driven-form', file, line, detail: 'ngModel binding' });
      }
    }
    // Rule 14 (orphan-ng-submit): an (ngSubmit) output binding, in any template
    // under src/. FormsModule and ReactiveFormsModule are both banned (rules 3
    // and 6), so the NgForm/FormGroupDirective that would ever fire this event
    // can never be present here; the binding just registers a dead DOM listener.
    if (n && typeof n.name === 'string' && Array.isArray(n.outputs)) {
      for (const o of n.outputs) {
        if (o.name === 'ngSubmit') {
          const line = (o.sourceSpan?.start?.line ?? 0) + 1 + lineOffset;
          acc.push({ kind: 'orphan-ng-submit', file, line, detail: '(ngSubmit) binding' });
        }
      }
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
      if (Array.isArray(v)) walkTemplateForNgModel(v, file, lineOffset, acc);
      else if (v && typeof v === 'object') walkTemplateForNgModel([v], file, lineOffset, acc);
    }
  }
}

export function countTemplateSource(template, { file, lineOffset = 0 }) {
  const { nodes } = parseTemplate(template, file, { preserveWhitespaces: false });
  const acc = [];
  walkTemplateForNgModel(nodes, file, lineOffset, acc);
  return acc;
}

// Pull every inline `template: \`...\`` string out of a component .ts.
function extractInlineTemplates(sourceText) {
  const sf = ts.createSourceFile('component.ts', sourceText, ts.ScriptTarget.Latest, true);
  const results = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      node.name.getText(sf) === 'template' &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))
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
  if (absPath.endsWith('.html')) return countTemplateSource(text, { file, lineOffset: 0 });
  if (absPath.endsWith('.ts')) {
    const acc = countTsSource(text, { file });
    for (const { text: tpl, lineOffset } of extractInlineTemplates(text)) {
      acc.push(...countTemplateSource(tpl, { file, lineOffset }));
    }
    return acc;
  }
  return [];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', 'coverage']);

export function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.html') || entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

export function tally(paths, opts = {}) {
  const files = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) files.push(...collectSourceFiles(p));
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
    if (isGated(v.kind)) totals.all += 1;
  }
  return { totals, violations };
}

// CLI: node component-shape-counter.mjs [--root <dir>] <path...>  ->  JSON tally.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let root;
  const ri = args.indexOf('--root');
  if (ri >= 0) {
    root = args[ri + 1];
    args.splice(ri, 2);
  }
  if (args.length === 0) {
    process.stderr.write('usage: node component-shape-counter.mjs [--root <dir>] <file-or-dir...>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(tally(args, { root }), null, 2) + '\n');
}

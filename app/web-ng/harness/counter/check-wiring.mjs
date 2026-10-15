#!/usr/bin/env node
// Wiring check: a public member that nothing renders.
//
// WHY THIS EXISTS. Two of the most expensive defects in the Hero Ops Console
// build were the same shape, and every automated instrument reported success
// through both of them:
//
//   Task 4  `MissionsViewModel.startEdit` was defined and called from no
//           template. The Edit dialog opened onto an empty body and
//           MissionService.update was unreachable from the UI. Four counters
//           read zero, 25 tests passed, the boot check rendered the route.
//
//   Task 5  `ThreatsViewModel.startCreate` was defined and called from no
//           template. Opening Edit and dismissing it with Escape left a stale
//           id in `editing`, so the next Create silently overwrote an
//           unrelated record. Same clean board.
//
// One made a feature dead; the other made a feature destructive. A drift
// counter cannot see either, because a counter measures the conformance of
// code that exists and neither of these was a conformance problem -- the
// missing thing was a call site that was never written.
//
// This check is deliberately NOT an ESLint rule. ESLint sees one file at a
// time, and a ViewModel and the template that binds it are different files.
// It has to be a project-wide pass, which is also why it lives beside the
// counters rather than beside the gate rules.
//
// WHAT IT REPORTS. For every class whose name ends in `ViewModel`, and every
// @Component class, it lists public and protected members that appear neither
// in the paired template nor anywhere else in the class's own file. Private
// members are ignored; they are the class's own business.
//
// Deliberate design decision: references from `.spec.ts` files DO NOT COUNT.
// "The test uses it but the application does not" is precisely the case worth
// flagging, not suppressing -- both defects above had passing unit tests that
// called the orphaned method directly.
//
// Usage:
//   node harness/counter/check-wiring.mjs --root . src
//   node harness/counter/check-wiring.mjs --root . src --json

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : process.cwd();
const asJson = args.includes('--json');
const targets = args.filter((a, i) => !a.startsWith('--') && i !== rootIndex + 1);
const scanDirs = targets.length ? targets : ['src'];

/** Every .ts file under the scan roots, excluding specs. */
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const files = scanDirs.flatMap((d) => collect(join(root, d)));

const decoratorName = (node) => {
  const decorators = ts.getDecorators?.(node) ?? [];
  return decorators
    .map((d) => (ts.isCallExpression(d.expression) ? d.expression.expression : d.expression))
    .filter(ts.isIdentifier)
    .map((id) => id.text);
};

const decoratorArg = (node, name) => {
  for (const d of ts.getDecorators?.(node) ?? []) {
    if (!ts.isCallExpression(d.expression)) continue;
    const callee = d.expression.expression;
    if (!ts.isIdentifier(callee) || callee.text !== name) continue;
    const arg = d.expression.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) return arg;
  }
  return null;
};

const propValue = (obj, key) => {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
  }
  return null;
};

const isPrivate = (member) =>
  (member.modifiers ?? []).some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.HashToken,
  ) || member.name?.getText?.().startsWith('#');

/** Members worth checking: declared properties and methods with a plain name. */
function publicMembers(classNode) {
  const out = [];
  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member)) continue;
    if (isPrivate(member)) continue;
    const name = member.name?.getText?.();
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    if (name === 'constructor') continue;
    out.push({ name, line: 0 });
  }
  return out;
}

const classes = { viewModels: [], components: [] };

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  sf.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const className = node.name.text;
    const decorators = decoratorName(node);
    const members = publicMembers(node).map((m) => ({
      ...m,
      line: sf.getLineAndCharacterOfPosition(
        node.members.find((x) => x.name?.getText?.() === m.name).getStart(sf),
      ).line + 1,
    }));

    if (/ViewModel$/.test(className)) {
      classes.viewModels.push({ file, className, members, text });
    }

    if (decorators.includes('Component')) {
      const meta = decoratorArg(node, 'Component');
      const providers = meta ? propValue(meta, 'providers')?.getText() ?? '' : '';
      const templateUrl = meta ? propValue(meta, 'templateUrl')?.getText().replace(/['"`]/g, '') : null;
      const inline = meta ? propValue(meta, 'template')?.getText() : null;
      classes.components.push({ file, className, providers, templateUrl, inline, members, text });
    }
  });
}

/** Resolve a component's template text, from templateUrl or an inline string. */
function templateOf(component) {
  if (component.inline) return component.inline;
  if (component.templateUrl) {
    const path = resolve(dirname(component.file), component.templateUrl);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return '';
}

const wordRe = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

/** Is `name` used anywhere in `body` other than at its own declaration? */
function usedInOwnFile(body, name) {
  const uses = body.match(new RegExp(`this\\.${name}\\b`, 'g'));
  return Boolean(uses && uses.length > 0);
}

const violations = [];

// --- ViewModels: check each against the template of the component providing it
for (const vm of classes.viewModels) {
  const host = classes.components.find((c) => wordRe(vm.className).test(c.providers));
  const template = host ? templateOf(host) : null;

  for (const member of vm.members) {
    if (usedInOwnFile(vm.text, member.name)) continue;
    if (template && wordRe(member.name).test(template)) continue;
    // Also allow a sibling ViewModel or component TS file to reference it.
    const referencedElsewhere = classes.components.some(
      (c) => c.className !== vm.className && wordRe(`${member.name}`).test(c.text) && wordRe(vm.className).test(c.text),
    );
    if (referencedElsewhere) continue;

    violations.push({
      kind: 'unreferenced-view-model-member',
      file: vm.file.replace(root + '\\', '').replace(root + '/', '').replaceAll('\\', '/'),
      line: member.line,
      detail: host
        ? `${vm.className}.${member.name} is bound in no template of ${host.className}`
        : `${vm.className}.${member.name} is used nowhere, and no component provides ${vm.className}`,
    });
  }
}

// --- Components: a public/protected member the component's own template never uses
for (const component of classes.components) {
  const template = templateOf(component);
  if (!template) continue;
  for (const member of component.members) {
    if (member.name === 'vm') continue; // the injected ViewModel handle
    if (usedInOwnFile(component.text, member.name)) continue;
    if (wordRe(member.name).test(template)) continue;
    violations.push({
      kind: 'unreferenced-component-member',
      file: component.file.replace(root + '\\', '').replace(root + '/', '').replaceAll('\\', '/'),
      line: member.line,
      detail: `${component.className}.${member.name} is referenced by nothing in its own template`,
    });
  }
}

violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const tally = {
  totals: {
    'unreferenced-view-model-member': violations.filter((v) => v.kind === 'unreferenced-view-model-member').length,
    'unreferenced-component-member': violations.filter((v) => v.kind === 'unreferenced-component-member').length,
    all: violations.length,
  },
  violations,
};

if (asJson) {
  console.log(JSON.stringify(tally, null, 2));
} else if (violations.length === 0) {
  console.log(
    `wiring check passed: every public member of ${classes.viewModels.length} ViewModel(s) and ${classes.components.length} component(s) is reachable`,
  );
} else {
  for (const v of violations) console.log(`${v.file}:${v.line}  ${v.detail}`);
  console.log(`\nwiring check FAILED: ${violations.length} unreferenced member(s)`);
}

process.exit(violations.length === 0 ? 0 : 1);

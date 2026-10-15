// The independent vocabulary counter (Part 4, the edit-time freeloader).
//
// Encodes the two template-AST rules of the freeloader spec (see
// ../freeloader-spec.md): legacy-control-flow and ng-class-style. It shares no
// code with the gate: the gate parses templates with angular-eslint, this counter
// parses them with Angular's own compiler (@angular/compiler parseTemplate) and
// extracts inline templates with the TypeScript compiler API. The strictTemplates
// freeloader is measured separately by strict-template-check.mjs (the compiler is
// its auditor), not here.

import { parseTemplate } from '@angular/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const norm = (p) => p.replaceAll('\\', '/');

const KINDS = ['legacy-control-flow', 'ng-class-style'];
const emptyTotals = () => {
  const t = {};
  for (const k of KINDS) t[k] = 0;
  t.all = 0;
  return t;
};

// The surface structural directives native control flow replaces. ngForOf is the
// desugared bound half of *ngFor; the surface directive is ngFor, so keying on
// these base names counts one per structural directive, not two.
const STRUCTURAL = new Set(['ngIf', 'ngFor', 'ngSwitch']);
const NG_CLASS_STYLE = new Set(['ngClass', 'ngStyle']);

const attrName = (a) => a?.name;

function walk(nodes, file, lineOffset, acc) {
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const line = (n.sourceSpan?.start?.line ?? 0) + 1 + lineOffset;

    // A structural directive (*ngIf/*ngFor/*ngSwitch) desugars to a Template node
    // carrying the directive in templateAttrs.
    if (Array.isArray(n.templateAttrs)) {
      const hit = n.templateAttrs.find((a) => STRUCTURAL.has(attrName(a)));
      if (hit) acc.push({ kind: 'legacy-control-flow', file, line, detail: `*${hit.name}` });
    }

    // An element node: check its static attributes and bound inputs for
    // ngClass / ngStyle.
    if (typeof n.name === 'string' && (Array.isArray(n.attributes) || Array.isArray(n.inputs))) {
      const all = [...(n.attributes ?? []), ...(n.inputs ?? [])];
      const hit = all.find((a) => NG_CLASS_STYLE.has(attrName(a)));
      if (hit) acc.push({ kind: 'ng-class-style', file, line, detail: hit.name });
    }

    // Angular block-AST child keys, verified against @angular/compiler: a
    // SwitchBlock exposes `groups` (NOT `cases`; the group then carries both),
    // and ForLoopBlock.empty plus DeferredBlock.placeholder/loading/error are
    // OBJECTS rather than arrays. The original list was children/branches/cases/
    // empty guarded on Array.isArray, so it descended into no @switch, @empty or
    // @defer body at all: violations inside them went uncounted, and the gate,
    // which does walk them, silently disagreed. Handle both shapes.
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
  walk(nodes, file, lineOffset, acc);
  return acc;
}

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
    const acc = [];
    for (const { text: tpl, lineOffset } of extractInlineTemplates(text)) {
      acc.push(...countTemplateSource(tpl, { file, lineOffset }));
    }
    return acc;
  }
  return [];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', 'coverage']);

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let root;
  const ri = args.indexOf('--root');
  if (ri >= 0) {
    root = args[ri + 1];
    args.splice(ri, 2);
  }
  if (args.length === 0) {
    process.stderr.write('usage: node freeloader-counter.mjs [--root <dir>] <file-or-dir...>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(tally(args, { root }), null, 2) + '\n');
}

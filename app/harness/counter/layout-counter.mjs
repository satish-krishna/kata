// The independent structural counter for Part 2 (layout and tokens).
//
// Encodes the layout-grammar spec (../layout-grammar-spec.md), which is the
// spartan styling docs plus the house-style skill, mechanized. Four kinds:
// raw-palette-color and space-utility (spartan), raw-css-literal (house, CSS),
// and the counter-only heuristic nested-flex-grid (house). Templates are parsed
// with @angular/compiler; stylesheets with a property-aware text scan that
// mirrors the gate's stylelint property list. Shares no code with the gate.

import { parseTemplate } from '@angular/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const norm = (p) => p.replaceAll('\\', '/');
const emptyTotals = () => ({
  'raw-palette-color': 0,
  'space-utility': 0,
  'raw-css-literal': 0,
  'nested-flex-grid': 0,
  all: 0,
});

const baseUtil = (t) => (t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t);

// A raw Tailwind palette color (blue-500, gray-700) or an arbitrary hex color,
// on a color utility. Semantic tokens (card, primary, muted-foreground) pass.
const PALETTE = new Set([
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
  'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
  'purple', 'fuchsia', 'pink', 'rose',
]);
const COLOR_PREFIX_RE =
  /^(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret|accent)-/;

function isRawPaletteColor(token) {
  const t = baseUtil(token);
  const m = t.match(COLOR_PREFIX_RE);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  if (rest.startsWith('[') && rest.includes('#')) return true; // bg-[#0af]
  if (rest === 'white' || rest === 'black') return true;
  const seg = rest.split('-');
  return PALETTE.has(seg[0]) && seg.length >= 2 && /^\d+$/.test(seg[1]);
}

const isSpaceUtil = (token) => /^space-(x|y)-/.test(baseUtil(token));

function classTokens(el) {
  const attr = el.attributes.find((a) => a.name === 'class');
  return attr && typeof attr.value === 'string' ? attr.value.split(/\s+/).filter(Boolean) : [];
}

function elementChildren(el) {
  return (el.children ?? []).filter(
    (n) => n && typeof n.name === 'string' && Array.isArray(n.attributes) && Array.isArray(n.inputs),
  );
}

function templateViolations(el, file, lineOffset, acc) {
  const line = (el.sourceSpan?.start?.line ?? 0) + 1 + lineOffset;
  for (const token of classTokens(el)) {
    if (isRawPaletteColor(token)) {
      acc.push({ kind: 'raw-palette-color', file, line, detail: token });
    } else if (isSpaceUtil(token)) {
      acc.push({ kind: 'space-utility', file, line, detail: `${token}, use gap-*` });
    }
  }
  // nested-flex-grid: a ROW of COLUMNS. The house doc's sentence is directional,
  // "a row of flex columns, each itself a flex stack, arranged to line up into a
  // grid", and direction is the entire discriminator: a row of columns reads as a
  // grid, a column of rows is an ordinary stack.
  //
  // The original encoding dropped it and flagged any flex container with two or
  // more flex children. Over seven capstone builds that proxy flagged 63 sites of
  // which ONE was the anti-pattern; the other 62 were mostly a `flex flex-col`
  // card body holding a header row and a content row. See layout-grammar-spec.md
  // rule 4 for the full correction, including the finding it cost.
  const own = classTokens(el).map(baseUtil);
  if (own.includes('flex') && !own.includes('flex-col')) {
    const colKids = elementChildren(el).filter((c) => {
      const k = classTokens(c).map(baseUtil);
      return k.includes('flex') && k.includes('flex-col');
    });
    if (colKids.length >= 2) {
      acc.push({
        kind: 'nested-flex-grid',
        file,
        line,
        detail: `flex row with ${colKids.length} flex-col children: this is a grid, use grid`,
      });
    }
  }
}

function walk(nodes, file, lineOffset, acc) {
  for (const n of nodes) {
    if (n && typeof n.name === 'string' && Array.isArray(n.attributes) && Array.isArray(n.inputs)) {
      templateViolations(n, file, lineOffset, acc);
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
  walk(nodes, file, lineOffset, acc);
  return acc;
}

// A raw color or px literal in a hand-written stylesheet, property-aware so it
// mirrors the gate's stylelint property list: colors flagged in color and
// background properties, raw px flagged in padding/margin/gap/border-radius.
// A value expressed as var(--token) passes.
const isColorProp = (p) => p.includes('color') || p === 'background';
const isSpaceProp = (p) => /padding|margin/.test(p) || p === 'gap' || p === 'border-radius';

export function countCssSource(css, { file, lineOffset = 0 }) {
  const acc = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const declRe = /([\w-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = declRe.exec(noComments)) !== null) {
    const prop = m[1].toLowerCase();
    const value = m[2].replace(/var\([^)]*\)/g, (s) => ' '.repeat(s.length));
    const line = lineOffset + noComments.slice(0, m.index).split('\n').length;
    if (isColorProp(prop)) {
      for (const c of value.match(/#[0-9a-fA-F]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(/g) ?? []) {
        acc.push({ kind: 'raw-css-literal', file, line, detail: `literal color ${c.trim()} in ${prop}` });
      }
    }
    if (isSpaceProp(prop)) {
      for (const px of value.match(/\b\d+(?:\.\d+)?px\b/g) ?? []) {
        acc.push({ kind: 'raw-css-literal', file, line, detail: `raw px ${px} in ${prop}` });
      }
    }
  }
  return acc;
}

// Extract inline template and inline styles from a component .ts. styleUrl files
// are scanned standalone by the directory walk, not followed here (double count).
function extractFromComponent(sourceText) {
  const sf = ts.createSourceFile('component.ts', sourceText, ts.ScriptTarget.Latest, true);
  const templates = [];
  const styles = [];
  const lit = (n) => (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n) ? n : null);
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name) {
      const key = node.name.getText(sf);
      const init = node.initializer;
      if (key === 'template' && lit(init)) {
        templates.push({ text: init.text, lineOffset: sf.getLineAndCharacterOfPosition(init.getStart(sf)).line });
      } else if (key === 'styles' && ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          const l = lit(el);
          if (l) styles.push({ text: l.text, lineOffset: sf.getLineAndCharacterOfPosition(l.getStart(sf)).line });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { templates, styles };
}

export function layoutCountFile(absPath, { root } = {}) {
  const file = root ? norm(relative(root, absPath)) : norm(absPath);
  const text = readFileSync(absPath, 'utf8');
  const acc = [];
  if (absPath.endsWith('.html')) {
    acc.push(...countTemplateSource(text, { file, lineOffset: 0 }));
  } else if (absPath.endsWith('.css')) {
    acc.push(...countCssSource(text, { file, lineOffset: 0 }));
  } else if (absPath.endsWith('.ts')) {
    const { templates, styles } = extractFromComponent(text);
    for (const t of templates) acc.push(...countTemplateSource(t.text, { file, lineOffset: t.lineOffset }));
    for (const s of styles) acc.push(...countCssSource(s.text, { file, lineOffset: s.lineOffset }));
  }
  return acc;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', 'coverage']);

export function collectLayoutFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...collectLayoutFiles(full));
    } else if (entry.endsWith('.html') || entry.endsWith('.ts') || entry.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

export function layoutTally(paths, opts = {}) {
  const files = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) files.push(...collectLayoutFiles(p));
    else files.push(p);
  }
  const violations = [];
  for (const p of files) violations.push(...layoutCountFile(p, opts));
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
    process.stderr.write('usage: node layout-counter.mjs [--root <dir>] <file...>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(layoutTally(args, { root }), null, 2) + '\n');
}

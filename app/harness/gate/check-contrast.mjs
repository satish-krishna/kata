#!/usr/bin/env node
// Contrast floor for the design tokens.
//
// WHY THIS EXISTS. This project's CLAUDE.md mandates WCAG AA. Nothing checked
// it. During the Hero Ops Console build the palette in src/styles.css was
// replaced with one where white-on-primary measured 2.80:1 -- below even the
// 3:1 large-text floor -- and it passed 29 lint rules, four drift counters,
// two linters, 42 tests, a boot check and a responsive check without a murmur.
// The `raw-css-literal` rule polices component stylesheets and deliberately
// exempts src/styles.css, so the one file where colour is actually decided was
// the one file with no colour rule at all.
//
// The failing values were not invented by an agent. They come from
// prototype/capstone-build-spec.md, the design document that governs this
// application, which specifies `action / primary #d8891a` with
// `on-primary #ffffff`. Nobody had ever run the arithmetic on the spec.
//
// This check is pure arithmetic over a fixed list of token pairs. No browser,
// no DOM, no AXE, no network. It runs in milliseconds and it cannot produce a
// false positive, because a contrast ratio is not a matter of opinion.
//
// Usage:
//   node harness/gate/check-contrast.mjs            # exits 1 on any failure
//   node harness/gate/check-contrast.mjs --json     # machine-readable tally

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLESHEET = join(ROOT, 'src', 'styles.css');

// Foreground/background pairs that must clear 4.5:1 (WCAG 2.x SC 1.4.3, normal
// text). Each entry names the foreground token and the background token; both
// are resolved per theme block.
const TEXT_PAIRS = [
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--destructive-foreground', '--destructive'],
  ['--accent-foreground', '--accent'],
  ['--muted-foreground', '--muted'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--foreground', '--background'],
  ['--sidebar-foreground', '--sidebar'],
  ['--sidebar-primary-foreground', '--sidebar-primary'],
  ['--sidebar-accent-foreground', '--sidebar-accent'],
];

// Non-text contrast (WCAG 2.x SC 1.4.11) must clear 3:1. SC 1.4.11 covers
// "visual information required to identify user interface components and
// states" -- a focus ring is exactly that, and a focus ring the user cannot see
// is a keyboard-accessibility failure rather than a cosmetic one. So the ring
// is checked against every surface it can land on, and it is enforced.
const UI_PAIRS = [
  ['--ring', '--background'],
  ['--ring', '--card'],
  ['--sidebar-ring', '--sidebar'],
];

// Reported, never enforced. A general-purpose border token draws card outlines
// and dividers, which are decoration rather than information required to
// identify a component, so 1.4.11 does not bind it and a 3:1 floor here would
// be a false positive. The first draft of this check enforced it and flagged
// two borders that are perfectly fine; a rule that cries wolf is a rule someone
// eventually switches off, so it prints for information and exits zero.
const ADVISORY_PAIRS = [
  ['--border', '--background'],
  ['--border', '--card'],
];

const TEXT_FLOOR = 4.5;
const UI_FLOOR = 3.0;

/** Relative luminance per WCAG 2.x, from a #rrggbb string. */
function luminance(hex) {
  const channel = (i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function ratio(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pull `--token: #rrggbb;` declarations out of each theme block. Only six-digit
 * hex is understood; anything else (oklch, a var() reference, a colour keyword)
 * is reported as unresolved rather than silently skipped, because a token this
 * check cannot read is a token it cannot vouch for.
 */
function readThemes(css) {
  const themes = {};
  const blocks = [
    ['light', /:root\s*\{([^}]*)\}/],
    ['dark', /:root\.dark\s*\{([^}]*)\}/],
  ];
  for (const [name, pattern] of blocks) {
    const body = css.match(pattern)?.[1];
    if (!body) continue;
    const resolved = {};
    const unresolved = {};
    for (const line of body.split(';')) {
      const m = line.match(/(--[a-z0-9-]+)\s*:\s*(.+)/i);
      if (!m) continue;
      const [, token, rawValue] = m;
      const value = rawValue.trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) resolved[token] = value.toLowerCase();
      else unresolved[token] = value;
    }
    themes[name] = { resolved, unresolved };
  }
  return themes;
}

function evaluate(css) {
  const themes = readThemes(css);
  const failures = [];
  const advisories = [];
  const skipped = [];
  const checked = [];

  for (const [themeName, theme] of Object.entries(themes)) {
    const run = (pairs, floor, kind, { enforce = true } = {}) => {
      for (const [fgToken, bgToken] of pairs) {
        const fg = theme.resolved[fgToken];
        const bg = theme.resolved[bgToken];
        if (!fg || !bg) {
          // Only report a genuinely missing pair once, and say which half.
          const missing = [!fg && fgToken, !bg && bgToken].filter(Boolean);
          const unreadable = missing.filter((t) => theme.unresolved[t]);
          if (unreadable.length) {
            skipped.push({
              theme: themeName,
              pair: `${fgToken} on ${bgToken}`,
              reason: `not six-digit hex: ${unreadable.map((t) => `${t}=${theme.unresolved[t]}`).join(', ')}`,
            });
          }
          continue;
        }
        const value = ratio(fg, bg);
        const record = {
          theme: themeName,
          kind,
          pair: `${fgToken} on ${bgToken}`,
          colors: `${fg} on ${bg}`,
          ratio: Number(value.toFixed(2)),
          floor,
        };
        if (!enforce) {
          if (value < floor) advisories.push(record);
          continue;
        }
        checked.push(record);
        if (value < floor) failures.push(record);
      }
    };
    run(TEXT_PAIRS, TEXT_FLOOR, 'text');
    run(UI_PAIRS, UI_FLOOR, 'ui');
    run(ADVISORY_PAIRS, UI_FLOOR, 'advisory', { enforce: false });
  }

  return { checked, failures, advisories, skipped };
}

const css = readFileSync(STYLESHEET, 'utf8');
const result = evaluate(css);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ totals: { checked: result.checked.length, failures: result.failures.length }, ...result }, null, 2));
} else {
  for (const s of result.skipped) {
    console.log(`skipped  ${s.theme.padEnd(5)}  ${s.pair}  (${s.reason})`);
  }
  for (const a of result.advisories) {
    console.log(
      `note     ${a.theme.padEnd(5)}  ${a.pair}  ${a.colors}  ${a.ratio}:1  (advisory only, not enforced)`,
    );
  }
  for (const f of result.failures) {
    console.log(
      `FAIL     ${f.theme.padEnd(5)}  ${f.pair}  ${f.colors}  ${f.ratio}:1  (needs ${f.floor}:1)`,
    );
  }
  if (result.failures.length === 0) {
    console.log(`contrast check passed: ${result.checked.length} token pair(s) clear their floor`);
  } else {
    console.log(`\ncontrast check FAILED: ${result.failures.length} of ${result.checked.length} pair(s) below floor`);
  }
}

process.exit(result.failures.length === 0 ? 0 : 1);

import { describe, it, expect } from 'vitest';
import { Linter, ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import angular from 'angular-eslint';
import seal from './index.mjs';
import { tally } from '../counter/counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fx = (name) => join(repoRoot, 'harness', 'counter', 'fixtures', name);

function lintHtml(code) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.html'],
      plugins: { seal },
      languageOptions: { parser: angular.templateParser },
      linterOptions: { noInlineConfig: true },
      rules: {
        'seal/no-raw-control': 'error',
        'seal/no-appearance-on-primitive': 'error',
        'seal/no-style-attribute': 'error',
        'seal/no-raw-icon': 'error',
        'seal/no-unknown-primitive': 'error',
        'seal/no-missing-composition-part': 'error',
      },
    },
    { filename: 'x.html' },
  );
}

const countByMessageId = (messages) => {
  const out = {};
  for (const m of messages) out[m.messageId] = (out[m.messageId] ?? 0) + 1;
  return out;
};

describe('sealing gate: template rules', () => {
  it('flags the dirty fixture with the exact messageId spread', () => {
    const messages = lintHtml(readFileSync(fx('dirty.html'), 'utf8'));
    expect(messages.some((m) => m.fatal)).toBe(false);
    expect(countByMessageId(messages)).toEqual({
      rawControl: 2,
      appearanceOnPrimitive: 2,
      styleAttribute: 1,
    });
  });

  it('passes the clean fixture with zero reports', () => {
    const messages = lintHtml(readFileSync(fx('clean.html'), 'utf8'));
    expect(messages).toEqual([]);
  });

  it('agrees with the independent counter on the same fixture bytes', () => {
    // Two engines, one spec: the gate (angular-eslint parser) and the counter
    // (@angular/compiler parser) must land on the same total, or the spec is
    // encoded wrong somewhere. This is the anti-circularity cross-check.
    const gateTotal = lintHtml(readFileSync(fx('dirty.html'), 'utf8')).length;
    const counterTotal = tally([fx('dirty.html')]).totals.all;
    expect(gateTotal).toBe(counterTotal);
  });

  it('flags the capstone dirty fixture with the exact messageId spread', () => {
    const messages = lintHtml(readFileSync(fx('capstone-seal-dirty.html'), 'utf8'));
    expect(messages.some((m) => m.fatal)).toBe(false);
    expect(countByMessageId(messages)).toEqual({
      rawControl: 8,
      appearanceOnPrimitive: 2,
      styleAttribute: 1,
      rawIcon: 1,
    });
  });

  it('passes the capstone clean fixture with zero reports', () => {
    const messages = lintHtml(readFileSync(fx('capstone-seal-clean.html'), 'utf8'));
    expect(messages).toEqual([]);
  });

  it('agrees with the independent counter on the capstone dirty fixture', () => {
    // Same cross-check as above, extended to the widened Part 1 vocabulary
    // plus the icon rule. If the other engine has not landed this yet, this
    // will fail independently of the gate-only assertions above.
    const gateTotal = lintHtml(readFileSync(fx('capstone-seal-dirty.html'), 'utf8')).length;
    const counterTotal = tally([fx('capstone-seal-dirty.html')]).totals.all;
    expect(gateTotal).toBe(counterTotal);
  });

  it('flags the capstone-residue dirty fixture with the exact messageId spread', () => {
    // Rules 5 and 6, the drift that got past rules 1-4 in the measured
    // capstone run. The fixture's own header comment hand-counts
    // missing-composition-part as 2 (dialog title + an hlmField ancestor
    // check), but sealing-spec.md's rule 6 has since dropped the
    // required-ancestor half entirely (over-broad; the capstone build's
    // toolbar search/select are legitimately unwrapped, and "is this control
    // part of a form" is not decidable from the template) - so the current,
    // spec-correct count is 1 (the dialog-title descendant only). See
    // harness/rules/no-missing-composition-part.md for the full note.
    const messages = lintHtml(readFileSync(fx('capstone-residue-seal-dirty.html'), 'utf8'));
    expect(messages.some((m) => m.fatal)).toBe(false);
    expect(countByMessageId(messages)).toEqual({
      unknownPrimitive: 4,
      missingCompositionPart: 1,
    });
  });

  it('passes the capstone-residue clean fixture with zero reports', () => {
    const messages = lintHtml(readFileSync(fx('capstone-residue-seal-clean.html'), 'utf8'));
    expect(messages).toEqual([]);
  });

  // The block-AST coverage case. Every violation in this fixture sits inside a
  // @switch, @empty or @defer body, which the counters used to walk straight
  // past while the gate walked them: a real two-engine disagreement that no
  // test could see, because every other cross-engine fixture is built from
  // @if and @for bodies only. An anti-circularity check that compares only the
  // cases where both engines are known to agree is not a check.
  it('agrees with the independent counter inside @switch, @empty and @defer bodies', () => {
    const src = readFileSync(fx('control-flow-blocks.html'), 'utf8');
    const gateTotal = lintHtml(src).length;
    const counterTotal = tally([fx('control-flow-blocks.html')]).totals.all;
    expect(counterTotal).toBe(9);
    expect(gateTotal).toBe(counterTotal);
  });

  it('agrees with the independent counter on the capstone-residue dirty fixture', () => {
    // Same cross-check as above, extended to rules 5 and 6. If the other
    // engine has not landed this yet, this will fail independently of the
    // gate-only assertions above.
    const gateTotal = lintHtml(readFileSync(fx('capstone-residue-seal-dirty.html'), 'utf8')).length;
    const counterTotal = tally([fx('capstone-residue-seal-dirty.html')]).totals.all;
    expect(gateTotal).toBe(counterTotal);
  });
});

describe('sealing gate: no suppression dial', () => {
  it('ignores an eslint-disable comment (noInlineConfig)', () => {
    const withDisable =
      '<!-- eslint-disable-next-line seal/no-raw-control -->\n<button>Save</button>';
    const messages = lintHtml(withDisable);
    // The rule error survives the disable comment: the escape hatch is dead.
    const errors = messages.filter((m) => m.ruleId === 'seal/no-raw-control' && m.severity === 2);
    expect(errors).toHaveLength(1);
    // And eslint declares the suppression void rather than honoring it.
    expect(messages.some((m) => /noInlineConfig/.test(m.message))).toBe(true);
  });
});

describe('sealing gate: end-to-end through the repo config', () => {
  it('seals inline templates in a .ts component via the processor', async () => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'eslint.config.mjs'),
    });
    const results = await eslint.lintFiles([fx('dirty.component.ts')]);
    const messages = results.flatMap((r) => r.messages);
    // Inline template: <button>Inline</button> (rawControl) + style on input.
    expect(countByMessageId(messages)).toEqual({ rawControl: 1, styleAttribute: 1 });
  });
});

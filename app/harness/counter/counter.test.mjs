import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tally, countFile } from './counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, 'fixtures', name);

describe('structural counter: external templates', () => {
  it('tallies the dirty fixture by exact kind', () => {
    const result = tally([fx('dirty.html')]);
    // Hand-counted from fixtures/dirty.html:
    //   raw-control:             <button>Save, <input />                    = 2
    //   appearance-on-primitive: bg- on hlmBtn, p- on hlmInput             = 2
    //   style-attribute:         static style="" on <div>                  = 1
    // NOT flagged: layout class on a primitive (justify-between, w-full),
    // a [style.width] binding, a bare <a>.
    expect(result.totals).toEqual({
      'raw-control': 2,
      'appearance-on-primitive': 2,
      'style-attribute': 1,
      'raw-icon': 0,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 5,
    });
  });

  it('finds zero violations in the clean fixture (all docs-good patterns)', () => {
    const result = tally([fx('clean.html')]);
    expect(result.totals).toEqual({
      'raw-control': 0,
      'appearance-on-primitive': 0,
      'style-attribute': 0,
      'raw-icon': 0,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 0,
    });
  });

  it('does not flag layout classes on a primitive, or a token-styled div', () => {
    expect(countFile(fx('clean.html'))).toEqual([]);
  });
});

describe('structural counter: inline templates in .ts components', () => {
  it('extracts and tallies an inline @Component template', () => {
    const result = tally([fx('dirty.component.ts')]);
    // <button>Inline (raw-control) + static style on <input hlmInput> (style-attribute)
    expect(result.totals).toEqual({
      'raw-control': 1,
      'appearance-on-primitive': 0,
      'style-attribute': 1,
      'raw-icon': 0,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 2,
    });
  });

  it('reports line numbers offset into the real .ts file, not the template', () => {
    const violations = countFile(fx('dirty.component.ts'));
    // The inline template starts at line 7 (`template: \``); the <button> is on
    // the following line, so it must report a line well past line 1.
    const button = violations.find((v) => v.kind === 'raw-control');
    expect(button.line).toBeGreaterThan(5);
  });
});

describe('structural counter: capstone seal (widened Part 1 spec)', () => {
  it('tallies the capstone dirty fixture by exact kind', () => {
    const result = tally([fx('capstone-seal-dirty.html')]);
    // Hand-counted in the fixture's own header, against sealing-spec.md:
    //   raw-control (8):             table, thead, tr, th, td (all missing
    //                                 their primitive attribute), label,
    //                                 textarea, and select (replacement-only)
    //   appearance-on-primitive (2): bg-blue-600 on hlmBtn, rounded-none on hlmBadge
    //   style-attribute (1):         static style="" on a <div>
    //   raw-icon (1):                an inline <svg> (:svg:svg)
    expect(result.totals).toEqual({
      'raw-control': 8,
      'appearance-on-primitive': 2,
      'style-attribute': 1,
      'raw-icon': 1,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 12,
    });
  });

  it('finds zero violations in the capstone clean fixture', () => {
    const result = tally([fx('capstone-seal-clean.html')]);
    expect(result.totals).toEqual({
      'raw-control': 0,
      'appearance-on-primitive': 0,
      'style-attribute': 0,
      'raw-icon': 0,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 0,
    });
  });

  it('is deterministic on the capstone fixtures: same input twice serializes byte-identical', () => {
    const a = JSON.stringify(tally([fx('capstone-seal-dirty.html'), fx('capstone-seal-clean.html')]));
    const b = JSON.stringify(tally([fx('capstone-seal-dirty.html'), fx('capstone-seal-clean.html')]));
    expect(a).toBe(b);
  });
});

describe('structural counter: capstone-residue seal (rules 5 and 6)', () => {
  it('tallies the capstone-residue dirty fixture by exact kind', () => {
    const result = tally([fx('capstone-residue-seal-dirty.html')]);
    // Hand-counted in the fixture's own header, against sealing-spec.md:
    //   unknown-primitive (4): hlmSelectTrigger and hlmAvatar written as
    //     attributes (installed as elements), hlm-sidebar written as an
    //     attribute (installed as an element), <hlm-avatar-image> written as
    //     an element (installed as the attribute hlmAvatarImage)
    //   missing-composition-part (1): hlm-dialog-content with no descendant
    //     carrying hlmDialogTitle. The fixture's bare hlmInput is deliberately
    //     NOT a violation: the field-wrapping half of the spartan forms doc is
    //     doc-only, not gated (sealing-spec.md, "What this rule deliberately
    //     does NOT check").
    expect(result.totals).toEqual({
      'raw-control': 0,
      'appearance-on-primitive': 0,
      'style-attribute': 0,
      'raw-icon': 0,
      'unknown-primitive': 4,
      'missing-composition-part': 1,
      all: 5,
    });
  });

  // This fixture DID surface a real spec/fixture disagreement while rules 5
  // and 6 were being written: its first hlm-select sits outside any hlmField,
  // which an earlier draft of rule 6 counted as a violation. The spec was the
  // arbiter and the spec lost: requiring every control to sit inside a field
  // would have hard-blocked the toolbar search box and class filter the
  // capstone build spec itself calls for, so that half of the rule is now
  // doc-only. See sealing-spec.md, "What this rule deliberately does NOT
  // check". The fixture was right and is unchanged.
  it('finds zero violations in the capstone-residue clean fixture', () => {
    const result = tally([fx('capstone-residue-seal-clean.html')]);
    expect(result.totals).toEqual({
      'raw-control': 0,
      'appearance-on-primitive': 0,
      'style-attribute': 0,
      'raw-icon': 0,
      'unknown-primitive': 0,
      'missing-composition-part': 0,
      all: 0,
    });
  });

  it('is deterministic on the capstone-residue fixtures: same input twice serializes byte-identical', () => {
    const a = JSON.stringify(
      tally([fx('capstone-residue-seal-dirty.html'), fx('capstone-residue-seal-clean.html')]),
    );
    const b = JSON.stringify(
      tally([fx('capstone-residue-seal-dirty.html'), fx('capstone-residue-seal-clean.html')]),
    );
    expect(a).toBe(b);
  });
});

describe('structural counter: output contract', () => {
  it('orders violations by file, then line, then kind', () => {
    const { violations } = tally([fx('dirty.html')]);
    const keys = violations.map((v) => `${v.file}::${String(v.line).padStart(4, '0')}::${v.kind}`);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('is deterministic: same input twice serializes byte-identical', () => {
    const a = JSON.stringify(tally([fx('dirty.html'), fx('dirty.component.ts')]));
    const b = JSON.stringify(tally([fx('dirty.html'), fx('dirty.component.ts')]));
    expect(a).toBe(b);
  });
});

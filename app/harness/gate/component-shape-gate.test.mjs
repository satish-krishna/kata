import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import shape from './component-shape-index.mjs';
import { countTsSource, countTemplateSource } from '../counter/component-shape-counter.mjs';

// The counter kinds that contribute to totals.all, used by the anti-circularity
// agreement tests below. This must stay the FULL gated set: if it lagged behind
// at the original six, an agreement test could compare a ten-rule gate against a
// six-kind counter and pass by accident, which is worse than failing.
const GATED = new Set([
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
  'inline-template',
  'inline-styles',
]);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fx = (n) => join(repoRoot, 'harness', 'counter', 'fixtures', n);

// All ten gated rules, in ONE set. There is deliberately no reduced rule set
// for the older fixtures: linting the pre-capstone fixtures with only the
// original six would let the gate stay green on a file the counter now flags,
// and a two-engine disagreement hidden by test configuration is exactly the
// circularity this harness exists to rule out. The reconciliation is asserted
// instead, on the fixture it actually affects.
const TS_RULES = {
  'shape/no-hand-set-change-detection': 'error',
  'shape/no-component-subscribe': 'error',
  'shape/no-forms-module': 'error',
  'shape/no-restated-validator': 'error',
  'shape/no-presentational-inject': 'error',
  'shape/no-reactive-form': 'error',
  'shape/no-root-provided-view-model': 'error',
  'shape/no-state-outside-view-model': 'error',
  'shape/no-feature-inject-data': 'error',
  'shape/no-unprovided-view-model': 'error',
  'shape/no-explicit-standalone': 'error',
  'shape/no-legacy-icon-module': 'error',
  'shape/no-unregistered-icon': 'error',
  'shape/no-inline-template': 'error',
};

function lintTs(code, filename) {
  return new Linter().verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser, parserOptions: { project: false } },
      plugins: { shape },
      linterOptions: { noInlineConfig: true },
      rules: TS_RULES,
    },
    { filename },
  );
}

function lintHtml(code) {
  return new Linter().verify(
    code,
    {
      files: ['**/*.html'],
      languageOptions: { parser: angular.templateParser },
      plugins: { shape },
      linterOptions: { noInlineConfig: true },
      rules: { 'shape/no-ng-model': 'error', 'shape/no-orphan-ng-submit': 'error' },
    },
    { filename: 'x.html' },
  );
}

// The pre-existing fixtures declare their templates inline, which
// no-inline-template now flags. They are kept byte-identical as records of the
// shapes they pin, so a "clean" assertion strips exactly the stated number of
// inlineTemplate reports (and fails if that number is off) and then requires
// zero of everything else.
const sansInline = (ms, n) => {
  expect(ms.filter((m) => m.messageId === 'inlineTemplate')).toHaveLength(n);
  return ms.filter((m) => m.messageId !== 'inlineTemplate');
};

const byId = (ms) => {
  const o = {};
  for (const m of ms) o[m.messageId] = (o[m.messageId] ?? 0) + 1;
  return o;
};

describe('component-shape gate: TS rules', () => {
  const dirty = readFileSync(fx('part3-dirty-ui.ts'), 'utf8');

  it('flags the dirty ui fixture with the exact messageId spread', () => {
    const ms = lintTs(dirty, 'src/app/ui/hero-card.ts');
    expect(ms.some((m) => m.fatal)).toBe(false);
    expect(byId(ms)).toEqual({
      handSetChangeDetection: 1,
      componentSubscribe: 1,
      formsModule: 1,
      restatedValidator: 1,
      presentationalInject: 1,
      reactiveForm: 1,
      inlineTemplate: 1,
    });
  });

  it('does not flag inject when the file is not under src/app/ui/', () => {
    expect(byId(lintTs(dirty, 'src/app/heroes/hero-card.ts')).presentationalInject).toBeUndefined();
  });

  // part3-clean.ts DEFINED clean under the original six rules, and is a
  // violation under the refined ten: a feature component that injects
  // HeroService and holds signal() state directly is exactly the shape the
  // MVVM refinement moves into a ViewModel. Keeping the fixture byte-identical
  // and asserting the reconciliation is stronger than asserting zero was: it
  // pins WHERE state is allowed to live, so future drift fails a test.
  // See component-shape-spec.md, "What the refinement did to Part 3's own
  // clean fixture".
  it('keeps the pre-capstone clean fixture clean of the six original rules', () => {
    const ids = byId(lintTs(readFileSync(fx('part3-clean.ts'), 'utf8'), 'src/app/heroes/hero-list.ts'));
    for (const id of [
      'handSetChangeDetection',
      'componentSubscribe',
      'formsModule',
      'restatedValidator',
      'presentationalInject',
      'reactiveForm',
    ]) {
      expect(ids[id]).toBeUndefined();
    }
  });

  it('flags the pre-capstone clean fixture under the MVVM refinement', () => {
    const ids = byId(lintTs(readFileSync(fx('part3-clean.ts'), 'utf8'), 'src/app/heroes/hero-list.ts'));
    // toSignal() is deliberately NOT state and must not count.
    expect(ids).toEqual({ featureInjectsData: 1, stateOutsideVm: 1, inlineTemplate: 1 });
  });
});

describe('component-shape gate: MVVM rules (capstone)', () => {
  const dirty = readFileSync(fx('capstone-mvvm-dirty.ts'), 'utf8');
  const clean = readFileSync(fx('capstone-mvvm-clean.ts'), 'utf8');

  it('flags the dirty MVVM fixture with the exact messageId spread, at a non-ui feature path', () => {
    const ms = lintTs(dirty, 'src/app/roster/roster.ts');
    expect(ms.some((m) => m.fatal)).toBe(false);
    expect(byId(ms)).toEqual({
      vmNotComponentScoped: 1,
      stateOutsideVm: 2,
      featureInjectsData: 2,
      vmNotProvided: 1,
      inlineTemplate: 1,
    });
  });

  it('passes the clean MVVM fixture with zero reports, at a non-ui feature path', () => {
    expect(sansInline(lintTs(clean, 'src/app/roster/roster.ts'), 1)).toEqual([]);
  });

  it('does not fire state-outside-vm or feature-injects-data when the file is under src/app/ui/', () => {
    // Rule 5 keys on the ui/ path; rules 8 and 9 key on its complement, so no
    // file is ever judged by both (component-shape-spec.md, MVVM section).
    // Rules 7 and 10 carry no path condition in the spec, so they still fire.
    const counts = byId(lintTs(dirty, 'src/app/ui/roster.ts'));
    expect(counts.stateOutsideVm).toBeUndefined();
    expect(counts.featureInjectsData).toBeUndefined();
    expect(counts.vmNotComponentScoped).toBe(1);
    expect(counts.vmNotProvided).toBe(1);
  });
});

describe('component-shape gate: capstone-residue rules (11-14, plus the two widenings)', () => {
  const dirty = readFileSync(fx('capstone-residue-shape-dirty.ts'), 'utf8');
  const clean = readFileSync(fx('capstone-residue-shape-clean.ts'), 'utf8');

  it('flags the dirty residue fixture with the exact messageId spread, at a non-ui feature path', () => {
    const ms = lintTs(dirty, 'src/app/roster/roster.ts');
    expect(ms.some((m) => m.fatal)).toBe(false);
    expect(byId(ms)).toEqual({
      explicitStandalone: 1,
      legacyIconModule: 1,
      unregisteredIcon: 1,
      componentSubscribe: 1,
      stateOutsideVm: 1,
      inlineTemplate: 2,
    });
  });

it('does not flag the app-level icon registration pattern (rule 13 regression guard)', () => {
    // NgIcon imported, no glyph symbols, no provideIcons: the documented
    // 'or app' pattern. An earlier draft of rule 13 flagged this and would
    // have blocked the only capstone builds whose icons worked.
    expect(
      sansInline(lintTs(readFileSync(fx('capstone-residue-icon-applevel.ts'), 'utf8'), 'src/app/hero-detail/hero-detail.ts'), 2),
    ).toEqual([]);
  });

  it('passes the clean residue fixture with zero reports, at a non-ui feature path', () => {
    expect(sansInline(lintTs(clean, 'src/app/roster/roster.ts'), 1)).toEqual([]);
  });
});

describe('component-shape gate: no-inline-template (rule 15)', () => {
  const comp = (body) => "@Component({ selector: 'app-x', " + body + ' })\nexport class X {}\n';
  const ids = (code, file = 'src/app/x.ts') => lintTs(code, file).map((m) => m.messageId);

  it('flags an inline template and inline styles, one report each', () => {
    expect(ids(comp('template: `<p></p>`, styles: [`p { margin: 0 }`],'))).toEqual(['inlineTemplate', 'inlineStyles']);
  });

  it('flags quoted keys the same as bare ones', () => {
    expect(ids(comp("'template': '<p></p>', 'styles': ['p {}'],"))).toEqual(['inlineTemplate', 'inlineStyles']);
  });

  it('passes templateUrl and styleUrl, and a component with no styles at all', () => {
    expect(ids(comp("templateUrl: './x.html', styleUrl: './x.css',"))).toEqual([]);
    expect(ids(comp("templateUrl: './x.html',"))).toEqual([]);
  });

  it('exempts spec files, and only spec files', () => {
    const code = comp('template: `<p></p>`, styles: [],');
    expect(ids(code, 'src/app/x.spec.ts')).toEqual([]);
    expect(ids(code, 'src/app/x.ts')).toEqual(['inlineTemplate', 'inlineStyles']);
  });

  it('agrees with the counter on the same source', () => {
    const code = comp('template: `<p></p>`, styles: [],');
    const counter = countTsSource(code, { file: 'src/app/x.ts' }).filter((v) => GATED.has(v.kind)).length;
    expect(lintTs(code, 'src/app/x.ts').length).toBe(counter);
  });
});

describe('component-shape gate: template rule', () => {
  it('flags ngModel and passes the clean template', () => {
    expect(byId(lintHtml(readFileSync(fx('part3-dirty.html'), 'utf8')))).toEqual({ ngModel: 1 });
    expect(lintHtml(readFileSync(fx('part3-clean.html'), 'utf8'))).toEqual([]);
  });

  it('flags orphan-ng-submit and passes the clean residue template', () => {
    expect(byId(lintHtml(readFileSync(fx('capstone-residue-shape-dirty.html'), 'utf8')))).toEqual({
      orphanNgSubmit: 1,
    });
    expect(lintHtml(readFileSync(fx('capstone-residue-shape-clean.html'), 'utf8'))).toEqual([]);
  });
});

describe('component-shape: gate and counter agree (anti-circularity)', () => {
  it('lands on the same gated total for the dirty ui fixture', () => {
    const dirty = readFileSync(fx('part3-dirty-ui.ts'), 'utf8');
    const gate = lintTs(dirty, 'src/app/ui/hero-card.ts').length;
    const counter = countTsSource(dirty, { file: 'src/app/ui/hero-card.ts' }).filter((v) => GATED.has(v.kind)).length;
    expect(gate).toBe(counter);
  });

  it('lands on the same total for the dirty template', () => {
    const dirty = readFileSync(fx('part3-dirty.html'), 'utf8');
    const gate = lintHtml(dirty).length;
    const counter = countTemplateSource(dirty, { file: 'd.html' }).filter((v) => GATED.has(v.kind)).length;
    expect(gate).toBe(counter);
  });
});

describe('component-shape gate: no suppression dial', () => {
  it('ignores an eslint-disable comment (noInlineConfig)', () => {
    const code = [
      "import { ChangeDetectionStrategy, Component } from '@angular/core';",
      '@Component({',
      "  selector: 'app-x',",
      '  // eslint-disable-next-line shape/no-hand-set-change-detection',
      '  changeDetection: ChangeDetectionStrategy.OnPush,',
      "  template: '',",
      '})',
      'export class X {}',
    ].join('\n');
    const ms = lintTs(code, 'src/app/x.ts');
    const errs = ms.filter((m) => m.ruleId === 'shape/no-hand-set-change-detection' && m.severity === 2);
    expect(errs).toHaveLength(1);
  });
});

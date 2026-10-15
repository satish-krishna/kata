import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countTsSource, countTemplateSource } from './component-shape-counter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, 'fixtures', n);
const tallyOf = (vs) => {
  const t = {};
  for (const v of vs) t[v.kind] = (t[v.kind] ?? 0) + 1;
  return t;
};

describe('component-shape counter', () => {
  const dirty = readFileSync(fx('part3-dirty-ui.ts'), 'utf8');

  it('tallies one of each kind on the dirty ui fixture', () => {
    const vs = countTsSource(dirty, { file: 'src/app/ui/hero-card.ts' });
    expect(tallyOf(vs)).toEqual({
      'hand-set-change-detection': 1,
      'component-subscribe': 1,
      'template-driven-form': 1,
      'restated-validator': 1,
      'presentational-injects-data': 1,
      'hand-written-form-model': 1,
      'reactive-form': 1,
      'dumb-holds-state': 1,
    });
  });

  it('does not fire the ui-path kinds outside src/app/ui/', () => {
    const t = tallyOf(countTsSource(dirty, { file: 'src/app/heroes/hero-card.ts' }));
    expect(t['presentational-injects-data']).toBeUndefined();
    expect(t['dumb-holds-state']).toBeUndefined();
    expect(t['hand-set-change-detection']).toBe(1);
  });

  // part3-clean.ts DEFINED clean under the original six kinds, and is a
  // violation under the refined ten: it is a feature component that injects
  // HeroService and holds signal() state directly, exactly the shape the MVVM
  // refinement moves into a ViewModel. That is the refinement working, not a
  // regression, so the fixture is kept byte-identical as a record of the
  // pre-capstone shape and this assertion pins the reconciliation instead.
  // See component-shape-spec.md, "What the refinement did to Part 3's own
  // clean fixture". Weakening rules 8 or 9 to make this green again would mean
  // a constitution that cannot invalidate its own past exemplars.
  it('keeps the pre-capstone clean fixture clean of the six original kinds', () => {
    const t = tallyOf(
      countTsSource(readFileSync(fx('part3-clean.ts'), 'utf8'), { file: 'src/app/heroes/hero-list.ts' }),
    );
    for (const kind of [
      'hand-set-change-detection',
      'component-subscribe',
      'template-driven-form',
      'restated-validator',
      'presentational-injects-data',
      'reactive-form',
      'hand-written-form-model',
      'dumb-holds-state',
    ]) {
      expect(t[kind]).toBeUndefined();
    }
  });

  it('flags the pre-capstone clean fixture under the MVVM refinement', () => {
    const t = tallyOf(
      countTsSource(readFileSync(fx('part3-clean.ts'), 'utf8'), { file: 'src/app/heroes/hero-list.ts' }),
    );
    // inject(HeroService) in a feature component, and signal() state on the
    // component class. toSignal() is deliberately NOT state and must not count.
    expect(t).toEqual({ 'feature-injects-data': 1, 'state-outside-vm': 1 });
  });

  it('flags ngModel in a template and passes the clean template', () => {
    expect(tallyOf(countTemplateSource(readFileSync(fx('part3-dirty.html'), 'utf8'), { file: 'd.html' }))).toEqual({
      'template-driven-form': 1,
    });
    expect(countTemplateSource(readFileSync(fx('part3-clean.html'), 'utf8'), { file: 'c.html' })).toEqual([]);
  });

  it('is deterministic: same bytes in, identical tally out', () => {
    const a = JSON.stringify(countTsSource(dirty, { file: 'src/app/ui/hero-card.ts' }));
    const b = JSON.stringify(countTsSource(dirty, { file: 'src/app/ui/hero-card.ts' }));
    expect(a).toBe(b);
  });
});

describe('component-shape counter: MVVM rules (capstone, rules 7-10)', () => {
  const mvvmDirty = readFileSync(fx('capstone-mvvm-dirty.ts'), 'utf8');
  const mvvmClean = readFileSync(fx('capstone-mvvm-clean.ts'), 'utf8');
  const featurePath = 'src/app/roster/roster.ts';

  it('tallies the hand-counted MVVM violations on the dirty fixture at a non-ui feature path', () => {
    const vs = countTsSource(mvvmDirty, { file: featurePath });
    expect(tallyOf(vs)).toEqual({
      'vm-not-component-scoped': 1,
      'state-outside-vm': 2,
      'feature-injects-data': 2,
      'vm-not-provided': 1,
    });
  });

  it('passes the clean MVVM fixture with zero violations at the same feature path', () => {
    expect(countTsSource(mvvmClean, { file: featurePath })).toEqual([]);
  });

  it('does not fire the ui/-gated MVVM rules (state-outside-vm, feature-injects-data) under src/app/ui/', () => {
    // Rules 8 and 9 key on the complement of the ui/ path (the mirror of rules 5
    // and 12), so they must not fire there. Rules 7 and 10 carry no ui/
    // restriction in the spec (a ViewModel's own scope, and a component's own
    // providers list, are judged the same way regardless of where the file
    // lives), so they are left out of this assertion on purpose.
    const t = tallyOf(countTsSource(mvvmDirty, { file: 'src/app/ui/roster.ts' }));
    expect(t['state-outside-vm']).toBeUndefined();
    expect(t['feature-injects-data']).toBeUndefined();
  });

  it('is deterministic: same bytes in, identical MVVM tally out', () => {
    const a = JSON.stringify(countTsSource(mvvmDirty, { file: featurePath }));
    const b = JSON.stringify(countTsSource(mvvmDirty, { file: featurePath }));
    expect(a).toBe(b);
  });
});

describe('component-shape counter: capstone-residue rules (11-14, plus two widenings)', () => {
  const residueDirty = readFileSync(fx('capstone-residue-shape-dirty.ts'), 'utf8');
  const residueClean = readFileSync(fx('capstone-residue-shape-clean.ts'), 'utf8');
  const featurePath = 'src/app/roster/roster.ts';

  it('tallies the residue violations on the dirty fixture at a non-ui feature path', () => {
    const vs = countTsSource(residueDirty, { file: featurePath });
    // Roster declares both `model = signal(...)` and `heroForm =
    // form(this.model, ...)`. `model` is the form's own model signal, the same
    // reactive state tree as the form itself (see component-shape-spec.md,
    // "A signal-form is a reactive state tree"), not a second piece of state,
    // so rule 8 counts it once, attributed to the form() hit, matching the
    // fixture header's "state-outside-vm (1): form() built on the component".
    // This is consistent with the pre-capstone part3-clean.ts fixture tested
    // above ("flags the pre-capstone clean fixture under the MVVM
    // refinement"), which has the identical model+form shape and pins
    // state-outside-vm at 1, not 2.
    expect(tallyOf(vs)).toEqual({
      'explicit-standalone': 1,
      'legacy-icon-module': 1,
      'unregistered-icon': 1,
      'component-subscribe': 1,
      'state-outside-vm': 1,
    });
  });

  it('does not flag the component that imports NgIcon and registers it correctly', () => {
    // RosterToolbar imports NgIcon and calls provideIcons({ lucideUsers }) in
    // its own providers. If rule 13 were "never import NgIcon" instead of the
    // spec's "NgIcon without provideIcons", unregistered-icon would tally 2
    // (RosterActions and RosterToolbar) instead of 1 (RosterActions only).
    const vs = countTsSource(residueDirty, { file: featurePath });
    expect(vs.filter((v) => v.kind === 'unregistered-icon')).toHaveLength(1);
  });

it('does not flag the app-level icon registration pattern (rule 13 regression guard)', () => {
    // NgIcon imported, no glyph symbols, no provideIcons: the documented
    // 'or app' pattern. An earlier draft of rule 13 flagged this and would
    // have blocked the only capstone builds whose icons worked.
    expect(countTsSource(readFileSync(fx('capstone-residue-icon-applevel.ts'), 'utf8'), { file: 'src/app/hero-detail/hero-detail.ts' })).toEqual([]);
  });

  it('passes the clean residue fixture with zero violations at the same feature path', () => {
    expect(countTsSource(residueClean, { file: featurePath })).toEqual([]);
  });

  it('is deterministic: same bytes in, identical residue tally out', () => {
    const a = JSON.stringify(countTsSource(residueDirty, { file: featurePath }));
    const b = JSON.stringify(countTsSource(residueDirty, { file: featurePath }));
    expect(a).toBe(b);
  });

  it('flags the orphan (ngSubmit) binding in the dirty template and passes the clean one', () => {
    expect(
      tallyOf(countTemplateSource(readFileSync(fx('capstone-residue-shape-dirty.html'), 'utf8'), { file: 'd.html' })),
    ).toEqual({ 'orphan-ng-submit': 1 });
    expect(countTemplateSource(readFileSync(fx('capstone-residue-shape-clean.html'), 'utf8'), { file: 'c.html' })).toEqual(
      [],
    );
  });

  it('is deterministic for the template half too', () => {
    const dirtyHtml = readFileSync(fx('capstone-residue-shape-dirty.html'), 'utf8');
    const a = JSON.stringify(countTemplateSource(dirtyHtml, { file: 'd.html' }));
    const b = JSON.stringify(countTemplateSource(dirtyHtml, { file: 'd.html' }));
    expect(a).toBe(b);
  });
});

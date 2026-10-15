# The component-shape spec (Part 3)

The written contract for Part 3, encoded twice and independently: by the gate (typescript-eslint over component `.ts` files, and angular-eslint over templates for the two template-level rules) and by the counter (the TypeScript compiler API for `.ts`, and Angular's own compiler for templates). Neither shares code, parser, or AST types with the other. This file is the arbiter if the two disagree on a fixture; one of the encodings is then wrong.

Read `sealing-spec.md` (Part 1) and `layout-grammar-spec.md` (Part 2) first. Part 3 is the last of the vocabulary arc, and it moves from the template into the component class: most of its rules are TypeScript-AST properties, not template ones.

## The rules are the docs, mechanized

Same load-bearing principle as Parts 1 and 2: every rule comes from a doc in the agent's baseline, and the gate enforces exactly what those docs say and permits everything they permit. Three sources feed Part 3, all present in both run conditions:

- **Angular's generated `CLAUDE.md`**: `OnPush` is the v22 default so do not set `changeDetection` explicitly; use the async pipe for observables; keep components small and single-responsibility; prefer signals for state; standalone is the v20+ default.
- **The spartan `forms.md` and `icons.md` docs**: spartan's `hlmField` and controls work with template-driven, reactive, and signal forms alike, so the forms rule is the house doc's, not spartan's. Icons are spartan's own: import the standalone `NgIcon`, and register every icon a component renders or an app-level registration handles it.
- **The house-style skill** (`.claude/skills/house-style`, `.agents/skills/house-style`): the container/presentational split, the MVVM section naming where state lives, the schema-driven forms pattern, and the "Submitting a form" section.

Doc-first, always, and here also **code-first**: the schema-driven pattern is unusable unless the repo actually has the substrate it names, so `zod` is installed and the `src/app/forms` helpers (`FormFieldMeta`, `formMeta`) are added before the gate mechanizes the rule. A gate for `validateStandardSchema` while the agent cannot import it would be a trap, not a test.

Two rules were promoted from a counter-only heuristic to a hard gate only after a measured run showed the agent drifting past the doc: [no-reactive-form](rules/no-reactive-form.md) (the house constitution overriding a framework fallback), and the MVVM rules below (the sharpest non-native pattern in the series). Both promotions required the doc override to be made explicit before the rule was gated, never after.

## What is installed (read from source, not memory)

At this substrate commit: Angular 22.1, SpartanNG 1.4.1, typescript-eslint 8.69, angular-eslint 22.2, and zod 4 (added as the forms substrate for this Part). Angular signal-forms ship inside `@angular/forms` as `@angular/forms/signals`; the installed build exports `form`, `submit`, `FormField`, `validateStandardSchema`, and the per-field validators `required`, `minLength`, `maxLength`, `min`, `max`, `email`, `pattern` (plus `validate`, `validateAsync`, `validateHttp`, `validateTree` for logic a schema cannot own). Because zod 4 is a Standard Schema, `validateStandardSchema(path, schema)` validates a whole signal-form through the zod schema natively, which is what makes the schema the single source of truth rather than a parallel copy of the rules.

The original Part 3 sketch said "schema-owned forms with zod," and that was correct: the house forms pattern is schema-driven with zod. A mid-series note that struck zod (reading only the earlier repo state, where zod was not yet installed and the baseline mentioned only signal-forms) was wrong and is reversed here. The `src/app/forms` helpers and the `<feature>.schema.ts` convention are the code half of the doc-first move.

## The measurement model (cumulative baseline)

By Part 3 the Part 1 sealing hook and the Part 2 layout hook are baseline: on in both conditions. The single variable Part 3 moves is the component-shape gate. gate-off is sealing plus layout; gate-on is sealing plus layout plus component shape. The full baseline (both MCP servers, the spartan and house-style skills including the component-shape, MVVM, and forms sections, Angular's `CLAUDE.md`, and the installed forms substrate) is identical and present in both conditions.

## The rules

Every gated Part 3 violation is one of exactly fifteen kinds. The gate reports them by `messageId`, one per row in the table below; the counter tallies them by `kind`, and the two counts differ by exactly one: `no-forms-module` (TypeScript) and `no-ng-model` (template) are two separate rules that both feed the single `template-driven-form` kind, so the counter's `totals` carries fourteen keys (see "The tally shape" below), not fifteen. Neither figure is a typo of the other; both are stated so.

The fifteen rules break down as seven original (`no-hand-set-change-detection`, `no-component-subscribe`, `no-forms-module`, `no-ng-model`, `no-restated-validator`, `no-presentational-inject`, `no-reactive-form`), four MVVM (added by the capstone), and four capstone-residue (`no-explicit-standalone`, `no-legacy-icon-module`, `no-unregistered-icon`, `no-orphan-ng-submit`).

| Rule | What it forbids |
| --- | --- |
| [no-hand-set-change-detection](rules/no-hand-set-change-detection.md) | An explicit `changeDetection` in `@Component` |
| [no-component-subscribe](rules/no-component-subscribe.md) | `.subscribe(...)` inside a component or ViewModel |
| [no-forms-module](rules/no-forms-module.md) | `FormsModule` in a component's imports |
| [no-restated-validator](rules/no-restated-validator.md) | A per-field signal-forms validator the zod schema already owns |
| [no-presentational-inject](rules/no-presentational-inject.md) | A `ui/` component injecting a data service |
| [no-reactive-form](rules/no-reactive-form.md) | Reactive forms (`ReactiveFormsModule`, `FormGroup`/`FormControl`/`FormBuilder`/`FormArray`) |
| [no-root-provided-view-model](rules/no-root-provided-view-model.md) | A ViewModel with `providedIn` |
| [no-state-outside-view-model](rules/no-state-outside-view-model.md) | A feature component declaring its own state signal or form |
| [no-feature-inject-data](rules/no-feature-inject-data.md) | A feature component injecting a data service directly |
| [no-unprovided-view-model](rules/no-unprovided-view-model.md) | A ViewModel injected but not listed in the component's `providers` |
| [no-explicit-standalone](rules/no-explicit-standalone.md) | An explicit `standalone` in `@Component` |
| [no-legacy-icon-module](rules/no-legacy-icon-module.md) | `NgIconsModule` in a component's imports |
| [no-unregistered-icon](rules/no-unregistered-icon.md) | Lucide glyph imports with no `provideIcons` anywhere in the file |
| [no-ng-model](rules/no-ng-model.md) | An `ngModel` binding in a template |
| [no-orphan-ng-submit](rules/no-orphan-ng-submit.md) | An `(ngSubmit)` binding, which no forms module in this repo can ever supply |

## The MVVM argument (added by the capstone)

The capstone adds a fifth doc source, the house-style skill's MVVM section, which says where inside a container the state actually lives. This is a **refinement** of the presentational-injects-data world, not a new one, and the reconciliation has to be stated explicitly or the two halves of Part 3 will disagree about where signals belong.

Before the capstone, the house doc said a container component "holds the signals." That sentence is now wrong on its own and has been rewritten: a container **owns** the state, and it owns it through a component-scoped ViewModel. The presentational half is untouched — `src/app/ui/` components still take `input()`/`output()` and inject no data. What moves is the other half: a feature component no longer holds signals or injects data services itself, its ViewModel does. `no-presentational-inject` keys on the `ui/` path; `no-state-outside-view-model` and `no-feature-inject-data` key on the complement of that path, so no file is ever judged by both.

This is the sharpest non-native pattern in the whole series. It is not Angular's documented shape, it is not spartan's, and it is not in the model's priors: the ComponentStore/presenter shape exists in the ecosystem, but nothing in the agent's baseline tells it to reach for one. Earlier parts of this series produced nulls because their gates were aimed at patterns the model already knew. This one is aimed squarely at the far side of that distance, and it is the single rule most likely to make the capstone fire.

A ViewModel is identified across all four MVVM rules by one syntactic marker: a class name ending in `ViewModel`, stated in the house doc so the agent is told the convention rather than made to guess it.

`no-state-outside-view-model` and `no-feature-inject-data` apply to EVERY `@Component` outside `src/app/ui/`, not only the routed screens, and the house doc was widened to say so before the rules were written. The narrower reading ("every routed feature screen") is what the pattern is FOR, but it is not decidable: nothing in a component file says whether it is routed, and a rule that cannot be decided cannot be enforced without guessing. The wider reading is also correct on the merits, since an app shell holding theme state in its own class has the same testability problem as a screen holding filter state, and the same fix. Doc-first means the doc moved first; the rule did not quietly outgrow it.

### What the refinement did to Part 3's own clean fixture

The reconciliation is not free, and the bill arrived immediately: `fixtures/part3-clean.ts`, the fixture that DEFINED clean under the original six kinds, is a violation under the refined ten. It is a feature component that injects `HeroService` and holds `signal(...)` state directly, which is precisely the shape the pre-refinement doc blessed and the MVVM rules now move into a ViewModel.

That is the refinement working, not a regression, and the fix is emphatically NOT to weaken the MVVM rules until the old fixture goes green again. A constitution that cannot invalidate its own past exemplars is not a constitution, it is a description of what the code already does. So the fixture is kept exactly as it was, as a historical record of the pre-capstone shape, and its assertion is rewritten to state what is now true: it is clean of the six original kinds, and it carries exactly the MVVM violations the refinement introduces. The test is stronger for it. Before, it asserted "this file is fine"; now it pins the reconciliation itself, so any future drift in where state is allowed to live fails a test rather than passing quietly.

## The capstone-residue rules

Four more gated kinds, plus two widenings of existing rules ([no-component-subscribe](rules/no-component-subscribe.md) and [no-state-outside-view-model](rules/no-state-outside-view-model.md); see each doc), added after the capstone run. Every one of them comes from drift the capstone measured getting past the full gate set, and none of them was tested by that run. They are the answer to the question the capstone actually asked, which was not "does this constitution work" but "does it catch everything," and the honest answer was no.

## Counter-only heuristics (measured, never gated)

Two Part 3 signals are not cleanly decidable and so are measured by the counter and reported as low-confidence, never used to block an edit. A heuristic that hard-blocks on a false positive is a bad gate; this is the same call Part 2 made for `nested-flex-grid`. Neither has a gate rule, so neither has a rule doc; this is their only written contract.

### `hand-written-form-model` (heuristic)

A form component whose model type is a locally declared `interface` or `type` for the form's shape, instead of `z.infer<typeof schema>`. The house rule is that the model is inferred from the schema. This is a heuristic because deciding that a given interface "is a form model" (rather than any other data shape) is not clean: the counter flags an `interface`/`type` that is used as the type argument of a `signal<...>()` which then feeds a `form(...)` call, and reports it as a smell, not a defect.

### `dumb-holds-state` (heuristic)

A component under `src/app/ui/` that declares writable non-input state (a `signal(...)` or `WritableSignal` field that is not an `input()`/`model()`). A presentational component holding mutable local state may be a legitimate self-contained widget (an open/closed toggle) or a container that leaked into `ui/`. The counter cannot tell which, so it counts and flags it as the lower-confidence smell of the two, not a defect.

## The tally shape (the counter's output contract)

```json
{
  "totals": {
    "hand-set-change-detection": 0,
    "component-subscribe": 0,
    "template-driven-form": 0,
    "restated-validator": 0,
    "presentational-injects-data": 0,
    "reactive-form": 0,
    "vm-not-component-scoped": 0,
    "state-outside-vm": 0,
    "feature-injects-data": 0,
    "vm-not-provided": 0,
    "explicit-standalone": 0,
    "legacy-icon-module": 0,
    "unregistered-icon": 0,
    "orphan-ng-submit": 0,
    "hand-written-form-model": 0,
    "dumb-holds-state": 0,
    "all": 0
  },
  "violations": [
    { "kind": "component-subscribe", "file": "src/app/heroes/hero-detail.ts", "line": 24, "detail": "this.route.params.subscribe" }
  ]
}
```

`totals.all` is the sum of the fourteen gated kinds only; the two heuristics are in `totals` but excluded from `all`, so `all` counts what the gate could have blocked. `violations` is ordered by file, then line, then kind, so the same committed input serializes byte-identically. That ordering is what makes the determinism self-test (same diff in, identical tally out) meaningful. A full audit runs all three counters (Part 1, Part 2, Part 3 kinds) and reports each, because the series is cumulative.

## What each engine parses

- TypeScript (`hand-set-change-detection`, `component-subscribe`, `restated-validator`, the `FormsModule` half of `template-driven-form`, `presentational-injects-data`, `reactive-form`, all four MVVM kinds, `explicit-standalone`, `legacy-icon-module`, `unregistered-icon`, and both heuristics): the gate runs custom typescript-eslint rules over the TypeScript AST (`@typescript-eslint/typescript-estree` node types); the counter walks the TypeScript compiler's own AST via the compiler API (`ts.createSourceFile`, `ts.forEachChild`). Different AST shapes, no shared code.
- Templates (the `ngModel` half of `template-driven-form`, and `orphan-ng-submit`): the gate uses the angular-eslint template parser; the counter uses `@angular/compiler`'s `parseTemplate`, reading `.html` files and inline `template:` strings.

Two engines, one spec, and the spec is the docs. If they ever disagree on a fixture, that disagreement is the finding.

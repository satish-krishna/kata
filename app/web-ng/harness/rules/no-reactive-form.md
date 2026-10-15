# no-reactive-form

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `reactiveForm`. Counter kind: `reactive-form`.

## What it forbids

`ReactiveFormsModule` in a component's `imports` array, or a `new FormGroup`/`FormControl`/`FormBuilder`/`FormArray` anywhere in the class body. Reported once per component, to match the counter's one-signal-per-component count.

## Why

The house-style skill overrides Angular's own fallback rather than extending it: `CLAUDE.md` offers reactive forms as the option when signal-forms do not fit, and the house-style skill overrides that fallback outright — no reactive forms, ever, in favor of signal-forms plus a zod schema. This is the one Part 3 rule where the house constitution overrides a framework endorsement instead of sharpening it.

This rule started as a counter-only heuristic and was promoted to a hard gate only after a measured run: across three gate-off trials the agent never used the house signal-forms pattern and reached for reactive forms in two of them. Promoting it required making the doc override explicit first — doc-first, always — so the gate mechanizes an unambiguous house rule and not a preference smuggled in at the gate.

## Accepted form

    protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));

## Agent guidance

Use the house forms pattern: Angular signal-forms driven by a zod schema.
Do NOT hand-roll a form with a plain signal, a manual (change) handler, and a
safeParse on submit; that passes the rules but is not the pattern. Copy this exact shape:

  // hero.schema.ts
  import { z } from 'zod';
  export const heroSchema = z.object({ name: z.string().min(1) });
  export type HeroModel = z.infer<typeof heroSchema>;

  // hero-detail.ts
  import { form, submit, validateStandardSchema } from '@angular/forms/signals';
  protected readonly model = signal<HeroModel>({ name: loadedHero.name });
  protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));

  <!-- template -->
  <input hlmInput [formField]="heroForm.name" />
  @for (e of heroForm.name().errors(); track e.kind) { <hlm-field-error>{{ e.message }}</hlm-field-error> }

Read the house-style skill's Forms section for the full example.

## Known blind spots

- `imports: [...FEATURE_IMPORTS]` hiding `ReactiveFormsModule` inside a spread constant is invisible to the `imports`-array half of the check.
- The `new FormGroup`/`FormControl`/`FormBuilder`/`FormArray` search walks the whole class body looking for a matching `NewExpression`, so it does not care how deeply nested the construction is — but it only matches those four exact identifiers; a reactive-forms class re-exported and constructed under a different local binding name would not match.
- Reported once per component regardless of how many reactive-forms constructs it contains, matching the counter's one-signal-per-component tally, so a component with three separate `FormGroup`s still reports once.

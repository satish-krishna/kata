# no-restated-validator

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `restatedValidator`. Counter kind: `restated-validator`.

## What it forbids

A call, inside a `@Component` class, to one of the signal-forms per-field constraint validators imported from `@angular/forms/signals`: `required`, `minLength`, `maxLength`, `min`, `max`, `email`, `pattern`.

## Why

The house-style skill: "Do NOT restate a rule as a per-field signal-forms validator: the schema already owns those." The house forms pattern makes the zod schema the single source of truth and reaches the form through `validateStandardSchema(path, schema)`. Calling a per-field validator in the form's rule function duplicates a rule the schema already states, which is the exact smell the schema-driven pattern exists to remove.

The escape-hatch validators — `validateHttp`, `validateAsync`, `validate`, `validateTree` — express server-side or cross-field logic a schema cannot own, so they are deliberately not on this list and are never flagged; banning them would fight the pattern rather than enforce it.

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

- Tracks only the seven names actually imported from `@angular/forms/signals`, under their local (possibly aliased) binding. A same-named `required`/`min`/`max` function imported from anywhere else, or hand-written locally, is not flagged — the rule follows the import, not the identifier text alone.
- It has no notion of "the schema already covers this field." A call to one of the seven validators is flagged unconditionally inside a component; the rule cannot and does not check whether the same constraint is or is not also expressed in the zod schema.

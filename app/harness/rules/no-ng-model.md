# no-ng-model

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `ngModel`. Counter kind: `template-driven-form` (template half; shared with [no-forms-module](no-forms-module.md), the TypeScript half of the same kind).

## What it forbids

An `ngModel` binding on an element, in any form: `[(ngModel)]="x"`, `[ngModel]="x"`, or a bare `ngModel` attribute.

## Why

The house-style skill removes template-driven forms entirely, in favor of the schema-driven signal-forms pattern. `ngModel` is the template-side half of that pattern — see [no-forms-module](no-forms-module.md) for why the two are one kind checked on two surfaces. This rule runs under the angular-eslint template parser, on `.html` files and inline `template:` strings, the same surface [no-orphan-ng-submit](no-orphan-ng-submit.md) runs on.

## Accepted form

    <input hlmInput [formField]="heroForm.name" />

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

- Checks the attribute/binding name only. It cannot tell a genuine `ngModel` violation from a differently-named directive that happens to be called `ngModel` in a project that redefined the selector — a theoretical edge case this repo's own vocabulary never produces.
- Fires on the binding regardless of whether `FormsModule` is actually imported, which is deliberate: an `ngModel` binding with no `FormsModule` import is inert markup, not a false positive to suppress, because dead markup is still markup a later edit can wake up (the same reasoning [no-raw-control](no-raw-control.md) states for markup inside an unrendered `<ng-template>`).

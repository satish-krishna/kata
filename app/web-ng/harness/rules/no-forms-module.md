# no-forms-module

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `formsModule`. Counter kind: `template-driven-form` (TypeScript half; shared with [no-ng-model](no-ng-model.md), the template half of the same kind).

## What it forbids

`FormsModule` listed in a `@Component`'s `imports` array.

## Why

The house-style skill removes template-driven forms entirely, in favor of the schema-driven signal-forms pattern: a zod schema is the single source of truth, the model is `z.infer<typeof schema>`, and validation flows through `validateStandardSchema(path, schema)`. `FormsModule` is the only thing that makes `ngModel` work, so banning the module and banning the binding ([no-ng-model](no-ng-model.md)) are two halves of one kind — `template-driven-form` — checked on two different surfaces: this rule sees the TypeScript import, `no-ng-model` sees the template binding. `CLAUDE.md` ranks template-driven forms last among Angular's own options; the house doc removes them outright, which is why this rule (unlike [no-reactive-form](no-reactive-form.md)) needed no promotion from a counter-only heuristic — it was gated from the start.

## Accepted form

    import { form, submit, validateStandardSchema } from '@angular/forms/signals';

    @Component({
      selector: 'app-hero-detail',
      imports: [],
      template: `<input hlmInput [formField]="heroForm.name" />`,
    })
    export class HeroDetail {
      protected readonly model = signal<HeroModel>({ name: '' });
      protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));
    }

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

- Does not resolve import bindings: it matches only elements literally named `FormsModule` in the `imports` array. An aliased import (`import { FormsModule as FM } from '@angular/forms'`) used under the local name `FM` evades this rule.
- Only inspects a static array literal for `imports`. A spread constant (`imports: [...FEATURE_IMPORTS]`) hiding `FormsModule` is invisible to this rule.

# no-orphan-ng-submit

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `orphanNgSubmit`. Counter kind: `orphan-ng-submit`.

## What it forbids

An `(ngSubmit)` output binding on any element, in any template under `src/`.

## Why

The house-style skill, "Submitting a form": the house pattern has exactly one submit path, `submit(this.form, ...)` from `@angular/forms/signals`, and `(ngSubmit)` is not part of it.

This rule deserves to be read carefully, because **the gate caused it.** `ngSubmit` is an output of `NgForm` and `FormGroupDirective`, which arrive only with `FormsModule` or `ReactiveFormsModule`. [no-forms-module](no-forms-module.md) and [no-reactive-form](no-reactive-form.md) ban both, so in this repo neither directive can ever be present, and an `(ngSubmit)` binding registers a DOM listener for an event nothing ever fires — Angular does not error on it, because it is a plain output binding syntax, not a directive-checked one. The capstone found four `(ngSubmit)` bindings and zero uses of `submit()` from signals: the agent's prior for "how a form submits" survived the ban on the modules that make it work, so the gate removed the mechanism and left the muscle memory, and every primary save flow in those builds was a dead button on a page that looked complete. A constitution that forbids an API without forbidding its usage has not prevented the pattern; it has broken it silently.

## Accepted form

    <form>
      <hlm-field> ... </hlm-field>
      <button hlmBtn type="submit">Save</button>
    </form>

## Agent guidance

There is exactly one submit path in this repo: submit(this.form, ...) from
@angular/forms/signals. (ngSubmit) is not part of it; NgForm and
FormGroupDirective, the only directives that fire it, ship with FormsModule and
ReactiveFormsModule, and this repo uses neither, so the binding is dead.
Copy this exact shape:

  <!-- template: no (ngSubmit) on the <form> -->
  <form>
    <hlm-field> ... </hlm-field>
    <button hlmBtn type="submit">Save</button>
  </form>

  // class: wire the submit through the form itself
  import { submit } from '@angular/forms/signals';
  protected readonly save = () => submit(this.form, async (f) => { /* ... */ });

Read the house-style skill's "Submitting a form" section for the full example.

## Known blind spots

- The rule bans the binding unconditionally, without checking whether `FormsModule`/`ReactiveFormsModule` are actually present. That is deliberate, for the same reason [no-ng-model](no-ng-model.md) does not check for `FormsModule`: an `(ngSubmit)` binding is dead in this repo's baseline regardless, and a rule gated on the modules' presence would not fire in the one case that matters, a fresh file that has not yet imported anything.
- It has nothing to say about whether a form actually calls `submit(this.form, ...)` anywhere. Removing `(ngSubmit)` satisfies this rule even if the form is never wired to submit at all; that gap is not decidable from a template binding's absence.

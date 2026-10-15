# no-state-outside-view-model

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `stateOutsideVm`. Counter kind: `state-outside-vm`. Widened: also fires on `form(...)`.

## What it forbids

A `@Component` class whose file is NOT under `src/app/ui/`, declaring a property whose initializer is a direct call to `signal`, `computed`, `linkedSignal`, or `form` (the last resolved as an import from `@angular/forms/signals`).

`input()`, `output()`, `model()`, `viewChild()`, `contentChild()`, `inject()`, and `toSignal()` are never flagged: they are component API or an edge conversion, not screen state.

A form's own backing model signal (its first argument, e.g. `form(this.model, ...)`) is not reported a second time under its own name when that argument resolves to another property on the same class. The form violation already names the property that has to move, and reporting both the model signal and the form built on it would be two reports for the one defect — moving the form out necessarily takes its model with it — the same once-per-defect call [no-reactive-form](no-reactive-form.md) makes for reactive forms.

## Why

The house-style skill: "It declares no `signal()`, `computed()`, or `linkedSignal()` of its own." This is the load-bearing MVVM rule — it is what actually forces the logic out of the component and into the testable ViewModel. The `ui/` complement matters: a presentational component holding a `signal()` is already measured, and only measured, by the counter-only `dumb-holds-state` heuristic (see the index), because a self-contained widget's open/closed toggle is legitimate. A feature component holding one is not ambiguous — the house doc names the ViewModel as the place — so the same syntactic property is a hard gate on one side of the `ui/` path split and a soft heuristic on the other, and that asymmetry is deliberate rather than an oversight.

The banned-initializer set originally was `signal`, `computed`, `linkedSignal`. It was widened to include `form(...)` after one capstone trial built a signal-form in the component while its ViewModel shrank to a model signal and a save method — MVVM satisfied in letter, with the state left outside. A signal-form is a reactive state tree and usually the largest piece of state on a screen, so leaving it out of this rule's reach would have left the sharpest instance of the defect uncovered.

## Accepted form

    // hero-detail.view-model.ts
    @Injectable()
    export class HeroDetailViewModel {
      readonly model = signal<HeroModel>({ name: '' });
      readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));
    }

    // hero-detail.ts
    @Component({ providers: [HeroDetailViewModel] })
    export class HeroDetail {
      protected readonly vm = inject(HeroDetailViewModel);
    }

## Agent guidance

Use the house MVVM pattern: a container owns its state through a component-scoped
ViewModel it provides and injects; it holds no signal()/computed() and injects no
data service itself. Copy this exact shape:

  // hero-detail.view-model.ts
  import { Injectable, inject, signal, computed } from '@angular/core';
  import { HeroService } from './hero.service';

  @Injectable() // no providedIn: this ViewModel is scoped to the component that provides it
  export class HeroDetailViewModel {
    private readonly heroes = inject(HeroService);
    readonly query = signal('');
    readonly filtered = computed(() => this.heroes.list().filter((h) => h.name.includes(this.query())));
  }

  // hero-detail.ts
  @Component({
    selector: 'app-hero-detail',
    providers: [HeroDetailViewModel], // provided at component scope, where it is injected
    template: `<p>{{ vm.filtered().length }}</p>`,
  })
  export class HeroDetail {
    protected readonly vm = inject(HeroDetailViewModel); // inject the ViewModel, not the service
    protected readonly route = inject(ActivatedRoute); // routing is still fine directly in the component
    // no signal()/computed() and no inject(HeroService) here: the ViewModel owns both
  }

Read the house-style skill's MVVM section for the full example.

## Known blind spots

- Only a *direct* call initializer is checked (`readonly x = signal(...)`). A signal built by an intermediate factory function (`readonly x = makeCounter()`, where `makeCounter` internally calls `signal`) is invisible to this rule.
- The form/model collapse only recognizes the model argument as `this.<name>` or a bare identifier resolving to another property on the *same* class. A model signal imported from elsewhere, or assembled through a helper, is not tied back to its form and could be double-counted or missed.
- The rule only inspects `@Component` classes; it says nothing about where the ViewModel puts its own state, which is correct — the ViewModel is exactly where this state belongs.

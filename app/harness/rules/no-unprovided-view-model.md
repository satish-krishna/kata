# no-unprovided-view-model

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `vmNotProvided`. Counter kind: `vm-not-provided`.

## What it forbids

A `@Component` class containing an `inject(X)` call where `X` ends in `ViewModel`, whose own `@Component` metadata has no `providers` array listing `X`.

## Why

The house-style skill: "The component lists it in its own `providers: [HeroDetailViewModel]`." This rule exists because nothing else catches the mistake: a component-scoped ViewModel that is injected without being provided is a `NullInjectorError` at runtime, not a build failure, so `ng build` passes and the screen dies only when it renders. That is the opposite of a situation where the TypeScript compiler has already built the dependency graph and a gate can ride it for free — here the framework defers the check to a moment this harness would only reach by accident, which is exactly why a static rule earns its keep.

`providers: [...someSpread]` is not statically resolvable and is treated as satisfying the rule: a gate that guesses at a spread's contents is worse than a gate with a stated blind spot.

## Accepted form

    @Component({
      selector: 'app-hero-detail',
      providers: [HeroDetailViewModel],
    })
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

- `providers: [...someSpread]` always satisfies the rule, even if the spread's actual contents omit the ViewModel. This is a deliberate false negative: resolving a spread's value statically is not decidable, and a gate that guesses would sometimes block a correct provider list.
- The check only looks at the injecting component's own `@Component` metadata. A ViewModel provided by an ancestor component or a route's `providers` array (which does satisfy Angular's DI at runtime, since an ancestor is still in the injecting component's chain) is not recognized and is flagged as unprovided even though the app would run correctly.

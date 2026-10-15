# no-feature-inject-data

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `featureInjectsData`. Counter kind: `feature-injects-data`.

## What it forbids

A `@Component` class whose file is NOT under `src/app/ui/`, calling `inject(X)` where `X` is `HttpClient` or an identifier ending in `Service`, excluding [no-presentational-inject](no-presentational-inject.md)'s pure-UI allowlist (the framework helpers and any `Hlm*` identifier).

## Why

The house-style skill: "it injects no data service: everything a container used to do directly, it now does through the ViewModel." This is [no-presentational-inject](no-presentational-inject.md) inverted across the `ui/` path split: that rule says a `ui/` component may not inject data because a container should; this rule says a container may not inject data either, because its ViewModel should. `inject(SomeViewModel)` never matches, because a `ViewModel` suffix is not a `Service` suffix, and `inject(ActivatedRoute)`/`inject(Router)` never match either — routing is how a screen learns which screen it is, and the house doc permits it directly in the component. The rule fires only inside `@Component` classes, so a ViewModel's own `inject(HeroService)` is never flagged: a ViewModel carries no `@Component` decorator.

## Accepted form

    // hero-detail.view-model.ts
    @Injectable()
    export class HeroDetailViewModel {
      private readonly heroes = inject(HeroService);
    }

    // hero-detail.ts
    @Component({ providers: [HeroDetailViewModel] })
    export class HeroDetail {
      protected readonly vm = inject(HeroDetailViewModel);
      protected readonly route = inject(ActivatedRoute);
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

- Shares [no-presentational-inject](no-presentational-inject.md)'s naming-convention limits: the `Service` suffix is a convention, not a type check, so a data-access class named without it is invisible here too.
- Only `inject(...)` calls are checked. A data service reached through constructor injection, or stashed in a module-level singleton and imported directly, is not decidable from this AST shape and is not flagged.

# no-root-provided-view-model

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `vmNotComponentScoped`. Counter kind: `vm-not-component-scoped`.

## What it forbids

A class whose name ends in `ViewModel`, decorated with `@Injectable({...})` or `@Service({...})`, whose metadata object has a `providedIn` property, set to any value.

## Why

The house-style skill: "The ViewModel is component-scoped ... A `providedIn: 'root'` ViewModel is a store wearing a ViewModel's name." A singleton ViewModel leaks one screen's state into the next visit to that screen, which is the whole defect the component-scoped lifetime prevents. A ViewModel is identified syntactically, by the `ViewModel` class-name suffix — the same promotion of a naming convention to a decidable marker that [no-presentational-inject](no-presentational-inject.md) makes for the `Service` suffix, and it is stated in the house doc so the agent is told the convention rather than made to guess it.

## Accepted form

    @Injectable()
    export class HeroDetailViewModel {
      private readonly heroes = inject(HeroService);
      readonly query = signal('');
    }

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

- Decidable purely from the property key's presence, like `no-hand-set-change-detection` and `no-explicit-standalone`: the rule does not evaluate the `providedIn` value, so `providedIn: null` still trips it even though it is functionally inert.
- The `ViewModel` suffix is the only marker. A component-scoped state holder named without that suffix is invisible to this rule and to [no-unprovided-view-model](no-unprovided-view-model.md) alike.

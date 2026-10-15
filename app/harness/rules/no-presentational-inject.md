# no-presentational-inject

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `presentationalInject`. Counter kind: `presentational-injects-data`.

## What it forbids

A component whose file path is under `src/app/ui/`, calling `inject(X)` where `X` is `HttpClient` or an identifier ending in `Service`, and `X` is not on the pure-UI allowlist (`ElementRef`, `DestroyRef`, `ChangeDetectorRef`, `Renderer2`, `NgZone`, `ViewContainerRef`, `TemplateRef`, or any identifier beginning with `Hlm`).

## Why

The house-style skill: "Presentational (dumb) components live under `src/app/ui/` ... They inject no application data service." A presentational component that reaches for a data service is doing a container's job. The property is made decidable by two concrete markers stated in the house doc itself, so the agent is told the convention rather than made to guess it: the file's path, and the `Service`/`HttpClient` naming convention. This rule is a name-based heuristic promoted to a hard gate deliberately — the `Service` suffix plus `HttpClient`, scoped to `ui/`, is the decidable slice the house convention makes checkable. A container component in a feature folder injecting the same service is correct and is never flagged, because the rule keys on the `ui/` path; whether a component outside `ui/` should have been presentational is a judgment call the counter-only `dumb-holds-state` heuristic measures instead (see the index).

## Accepted form

    // src/app/ui/hero-card.ts
    @Component({ selector: 'app-hero-card', template: `...` })
    export class HeroCard {
      readonly hero = input.required<Hero>();
      readonly select = output<Hero>();
    }

## Agent guidance

A `ui/` component takes `input()`/`output()` and injects nothing beyond framework or spartan helpers. Push data access up to a container in a feature folder.

    Good: readonly hero = input.required<Hero>();  // src/app/ui/hero-card.ts, no inject()
    Bad:  private readonly heroes = inject(HeroService);  // in a src/app/ui/ component

## Known blind spots

- The allowlist is a fixed set of framework helpers plus the `Hlm*` prefix. A legitimate non-data injectable that does not match either — a new framework token added in a later Angular release, say — would be flagged as a false positive until the allowlist is updated.
- The `Service` suffix is a naming convention, not a type check. A data-access class named without the suffix (`HeroRepository`) is invisible to this rule, and a purely presentational class that happens to be named `*Service` would be flagged.
- Only `src/app/ui/` is treated as presentational. A component outside that path holding the same shape is not checked by this rule at all; see `dumb-holds-state` in the index.

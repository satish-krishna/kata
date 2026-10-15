# no-explicit-standalone

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `explicitStandalone`. Counter kind: `explicit-standalone`.

## What it forbids

A `@Component({...})` decorator whose metadata object has a `standalone` property, set to any value.

## Why

`CLAUDE.md`, verbatim: "Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+." This is the same AST shape as [no-hand-set-change-detection](no-hand-set-change-detection.md): the presence of the property key in the decorator's object literal, not its value. It is the cheapest rule in the entire constitution, and it fired 19 times across three gate-on capstone builds — a rule stated verbatim in the baseline docs, trivially decidable, violated in nearly every component, and invisible before this because no one had thought to mechanize the easy one.

## Accepted form

    @Component({
      selector: 'app-hero-detail',
      template: `...`,
    })
    export class HeroDetail {}

## Agent guidance

Do not set `standalone` in `@Component` at all. Standalone is the Angular v20+ default.

    Good: @Component({ selector: 'app-hero-detail', template: `...` })
    Bad:  @Component({ selector: 'app-hero-detail', standalone: true, template: `...` })

## Known blind spots

- Same limits as [no-hand-set-change-detection](no-hand-set-change-detection.md): a computed property key or a spread-introduced `standalone` property is not resolved.
- The rule flags `standalone: false` exactly the same as `standalone: true`, since the decidable fact is the property's presence, not its value — which is correct here, since neither value should be written explicitly.

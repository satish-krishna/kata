# no-hand-set-change-detection

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `handSetChangeDetection`. Counter kind: `hand-set-change-detection`.

## What it forbids

A `@Component({...})` decorator whose metadata object literal has a `changeDetection` property, set to any value — `ChangeDetectionStrategy.OnPush` included, not only `Default`.

## Why

`CLAUDE.md`: "Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+." The decidable property is the inverse of the rule's original sketch: the violation is setting `changeDetection` at all, not the absence of `OnPush`. That is decidable from the AST alone — the presence of the property key in the decorator's object literal — with no type information required.

## Accepted form

    @Component({
      selector: 'app-hero-detail',
      template: `...`,
    })
    export class HeroDetail {}

## Agent guidance

Do not set `changeDetection` in `@Component` at all. `OnPush` is the Angular v22 default; a component that needs it gets it for free.

    Good: @Component({ selector: 'app-hero-detail', template: `...` })
    Bad:  @Component({ selector: 'app-hero-detail', changeDetection: ChangeDetectionStrategy.OnPush, template: `...` })

## Known blind spots

- The check is a literal property-key match (an `Identifier` named `changeDetection`, or a `Literal` key with that value). A computed key (`['changeDetection']: ...`) or a `changeDetection` introduced through a spread variable (`@Component({ ...base, changeDetection: X })`) is invisible to this rule.
- It fires only on a `@Component({...})` call whose argument is an object literal; a decorator metadata object built by an intermediate factory function is not resolved.

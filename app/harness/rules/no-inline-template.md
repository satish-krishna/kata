# no-inline-template

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageIds: `inlineTemplate`, `inlineStyles`. Counter kinds: `inline-template`, `inline-styles`.

## What it forbids

A `@Component({...})` decorator whose metadata object has a `template` property (`inlineTemplate`) or a `styles` property (`inlineStyles`), set to any value. Files named `*.spec.ts` are exempt.

## Why

The house rule: every component keeps its template in a separate `.html` file and any component-local styles in a separate stylesheet file. Templates and styles are reviewed, linted, and diffed as their own file types, and the template-level rules in this plane (`no-ng-model`, `no-orphan-ng-submit`) and the sealing and layout planes read `.html` directly. This is the same AST shape as [no-explicit-standalone](no-explicit-standalone.md): the presence of the property key in the decorator's object literal, not its value.

The rule does not require a stylesheet. A component with no styles of its own needs none: Kata's `.k-*` classes live globally in `src/styles/kata/` by design.

## Accepted form

    @Component({
      selector: 'app-hero-detail',
      templateUrl: './hero-detail.html',
    })
    export class HeroDetail {}

## Agent guidance

Put the markup in a sibling `.html` file and reference it with `templateUrl`. If the component needs its own styles, put them in a sibling stylesheet and reference it with `styleUrl`; otherwise add no stylesheet.

    Good: @Component({ selector: 'app-hero-detail', templateUrl: './hero-detail.html' })
    Bad:  @Component({ selector: 'app-hero-detail', template: `<p>hi</p>`, styles: [`p { color: red }`] })

## Known blind spots

- A spread-introduced `template`/`styles` property is not resolved. The gate does catch shorthand (`{ template }`) and a literal computed key (`{ ['template']: x }`), but the counter's property lookup sees only plain `key: value`, so on those two forms the engines disagree. `no-explicit-standalone` and its siblings share the same gap.
- Spec files are exempt, decided by the linted filename ending in `.spec.ts`. A test-host component in a non-spec helper file is not exempt, and an inline template in a file renamed to `*.spec.ts` is not seen.
- The rule flags `template: ''` exactly like a populated template, since the decidable fact is the property's presence, not its value.

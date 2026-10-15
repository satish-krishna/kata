# no-raw-palette-color

> Plane: layout. Index: [../layout-grammar-spec.md](../layout-grammar-spec.md). messageId: `rawPaletteColor`. Counter kind: `raw-palette-color`.

## What it forbids

A color utility class whose value is a raw Tailwind palette name plus a shade number (`bg-blue-500`, `text-gray-700`, `border-gray-200`), an arbitrary hex bracket (`bg-[#0af]`), or the literal `white`/`black` keyword, on any color-bearing prefix (`bg-`, `text-`, `border-`, `ring-`, `fill-`, `stroke-`, `from-`, `via-`, `to-`, `divide-`, `outline-`, `decoration-`, `placeholder-`, `caret-`, `accent-`). Responsive and state prefixes are stripped before classifying, so `dark:bg-blue-600` still trips it. A semantic token (`bg-card`, `text-muted-foreground`) and a non-color arbitrary value (`sm:max-w-[425px]`) both pass.

## Why

Spartan's styling doc is explicit: semantic colors only, never a raw Tailwind palette value on a spartan component. This rule mechanizes that line directly and runs its own classifier independent of the structural counter, so the two engines' agreement on a fixture is a real cross-check rather than shared code producing the same answer twice.

## Accepted form

    <div class="bg-card text-card-foreground border-border border">

## Agent guidance

Reach for a semantic token, never a raw palette shade or hex value.

    Good: <div class="bg-card text-card-foreground border-border border">
    Bad:  <div class="bg-blue-600 text-white">

## Known blind spots

- The rule only reads the static `class` attribute as a literal string. A palette color assembled through a `[class]` binding expression is invisible to it.
- Any token name that is not a recognized Tailwind palette word is accepted as "semantic" by default — the rule has no list of actual design tokens to check against, so a made-up class name that happens to avoid the palette pattern also passes.
- It only looks at template classes. A raw color literal in a component's own stylesheet is a different rule, `raw-css-literal`, enforced by stylelint rather than by an eslint rule.

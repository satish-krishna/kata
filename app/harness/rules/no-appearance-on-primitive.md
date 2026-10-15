# no-appearance-on-primitive

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `appearanceOnPrimitive`. Counter kind: `appearance-on-primitive`.

## What it forbids

An appearance-override utility class on an element that is already a primitive (a primitive element name, or a native element carrying a primitive attribute directive).

Appearance means color, typography, decoration, and internal padding: `bg-*`, `text-*` (except the alignment keywords `text-left`/`text-center`/etc.), `font-*`, `leading-*`, `tracking-*`, `border`/`border-*`, `rounded`/`rounded-*`, `shadow`/`shadow-*`, `ring`/`ring-*`, and `p*-*` padding utilities. Responsive and state prefixes (`sm:`, `hover:`, `dark:`, ...) are stripped before classifying, so `dark:bg-blue-600` still trips it.

Layout and spacing classes on the same element are not touched: display, flex/grid arrangement, dimensions, margins, and position utilities are all allowed on a primitive.

## Why

Spartan's own styling doc draws this exact line: `class` is for layout only, and overriding a component's own colors, typography, or internal padding belongs in the copied Helm file or a CSS variable, not at the call site. This rule enforces that line rather than adding one of its own — the primitives share a vocabulary of `libs/ui` sources exactly because their appearance is meant to be customized in one place, not re-decided at every usage.

This rule's appearance/layout classifier is written independently of the structural counter, sharing no code and no parser with it, so the two engines' agreement on a fixture is a real cross-check rather than shared code producing the same answer twice.

## Accepted form

    <div hlmCardFooter class="justify-between">
    <hlm-dialog-content class="sm:max-w-[425px]">
    <button hlmBtn class="w-full">

## Agent guidance

Do not fight a primitive's look with a class at the call site. Use its `variant`/`size` input, or edit the owned copy of the component in `libs/ui`.

    Good: <button hlmBtn class="w-full">Save</button>
    Bad:  <button hlmBtn class="bg-blue-600 rounded-none">Save</button>

## Known blind spots

- The rule only reads the static `class` attribute as a literal string. A class assembled through a `[class]` binding expression is invisible to it — the same appearance override reached through a computed binding is not caught here.
- The appearance/layout split is a fixed set of utility prefixes, not a semantic model of Tailwind. A future utility that does not match one of these prefixes but still changes an appearance property would pass unnoticed.
- It has no opinion on whether the layout classes it allows are the right layout — that judgment belongs to `no-nested-flex-grid` and the house-style skill, not to this rule.

# no-space-utility

> Plane: layout. Index: [../layout-grammar-spec.md](../layout-grammar-spec.md). messageId: `spaceUtility`. Counter kind: `space-utility`.

## What it forbids

A `space-x-*` or `space-y-*` utility class on any element, at any responsive or state prefix (`sm:space-y-4` still trips it, since prefixes are stripped before classifying).

## Why

Spartan's styling doc states the spacing convention directly: use `flex`/`grid` with `gap-*` for spacing between items, and avoid `space-x-*`/`space-y-*`. This rule mechanizes that line as written; there is no additional argument to make beyond the doc's own instruction.

## Accepted form

    <div class="flex flex-col gap-4">

## Agent guidance

Use `gap-*` on the flex or grid container instead of a `space-*` utility on the children.

    Good: <div class="flex flex-col gap-4">
    Bad:  <div class="space-y-4">

## Known blind spots

- The rule only reads the static `class` attribute as a literal string, so a `space-*` utility assembled through a `[class]` binding is invisible to it.
- It only forbids `space-*`; it does not check that `gap-*` (or any spacing at all) is actually present, so an element that drops spacing entirely instead of switching to `gap-*` still passes.

# no-raw-icon

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `rawIcon`. Counter kind: `raw-icon`.

## What it forbids

A raw inline `<svg>` root element in an application template. Because both the angular-eslint template parser and `@angular/compiler` namespace SVG nodes, the element arrives as `:svg:svg`, and the rule matches that exact name rather than a prefix — so it reports once per pasted icon, at the root, and does not also fire on every namespaced descendant (`:svg:path`, `:svg:g`, ...) inside it.

## Why

Pasted SVG markup bypasses the icon registry entirely: it cannot be themed or swapped through `provideIcons`, it usually duplicates a glyph the Lucide set already ships, and across measured builds it was the single largest source of unreviewable markup in a hand-built screen. The house-style skill states the fix plainly — icons are `<ng-icon>`, never inline SVG — and this rule mechanizes exactly that line.

The rule is narrow on purpose, twice over. It does not gate the matching `provideIcons` registration on the component class: registration is a fact about the class, the icon name is a fact about the template, and the two template engines this harness runs cannot see the class at all, so checking it here would break the two-engine symmetry the whole design depends on. It also does not touch `libs/**`, because Helm component internals legitimately inline SVG, and that is customization territory that belongs to `no-appearance-on-primitive`, not this rule.

## Accepted form

    <ng-icon name="lucideTrash2" />

with `provideIcons({ lucideTrash2 })` on the component.

## Agent guidance

Never paste SVG markup into a template. Use `<ng-icon>` with a registered Lucide name.

    Good: <ng-icon name="lucideTrash2" />
    Bad:  <svg viewBox="0 0 24 24"><path d="M3 6h18" /></svg>

## Known blind spots

- It says nothing about whether the icon name given to `<ng-icon>` is actually registered via `provideIcons` on the component. `@ng-icons` fails silently on an unregistered name — no build error, just a blank render — and that half of the contract is not decidable from a template alone, so it stays doc-only rather than gated here.
- `libs/**` is ignored wholesale, so an inline `<svg>` inside a Helm component file never reports, deliberately.
- SVG pasted inside a `<ng-template>` that is never rendered still reports; the rule does not check whether the markup is reachable.

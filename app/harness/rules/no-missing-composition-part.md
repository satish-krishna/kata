# no-missing-composition-part

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `missingCompositionPart`. Counter kind: `missing-composition-part`.

## What it forbids

An overlay container primitive present without a required descendant somewhere under it in the same template: `hlm-dialog-content` needs a descendant carrying `hlmDialogTitle`, and `hlm-sheet-content` needs one carrying `hlmSheetTitle`. This is a pure parent/child containment property of a single template AST — no cross-file join, no type information, no heuristic — so the search walks every container-shaped child (including inside `@if`, `@for`, and other control-flow blocks) looking for the attribute anywhere beneath the primitive.

## Why

`no-raw-control` and `no-unknown-primitive` ask whether a primitive is present and whether it is real, but neither asks whether it was assembled correctly, and a half-composed primitive is its own distinct defect: the outer shell renders, so the screen looks finished, while the part carrying the accessibility contract is missing. Spartan's composition doc states plainly that overlays need a title — "Dialog, Sheet, and Alert Dialog must have a title for accessibility. If the design hides it, keep it present and apply `class="sr-only"`" — and both capstone builds that shipped a retire dialog used a bare `<h2 class="font-semibold">` instead of `hlmDialogTitle`, so neither dialog had an accessible name despite looking correct on screen.

The check is deliberately scoped to one template. A title supplied by a wrapper component in a different file would be a false positive under this rule, but overlays in this repo are composed inline at the call site, which is what makes a single-template check sound here rather than merely convenient.

An earlier draft of this rule went further and required every `hlmInput`, `hlmTextarea`, and `hlm-select` to have an `hlmField` ancestor, mechanizing spartan's forms doc ("Use `hlmField`, not raw `div`s"). That was over-broad and was cut: the capstone build spec itself calls for a search input and a class-filter select in a toolbar, and neither is a form field — wrapping them in `hlmField` would add label, error, and description slots the design does not want. Whether a control is "part of a form" is not decidable from the template, since Signal Forms need no `<form>` element at all, so that convention stays doc-only in the house-style skill rather than gated here.

## Accepted form

    <hlm-dialog-content>
      <h2 hlmDialogTitle>Retire hero?</h2>
      ...
    </hlm-dialog-content>

## Agent guidance

Every `hlm-dialog-content` or `hlm-sheet-content` needs a title element inside it. If the design hides the title, keep it present with `class="sr-only"` rather than removing it.

    Good: <hlm-dialog-content><h2 hlmDialogTitle>Retire hero?</h2>...</hlm-dialog-content>
    Bad:  <hlm-dialog-content><h2 class="font-semibold">Retire hero?</h2>...</hlm-dialog-content>

## Known blind spots

- The search is scoped to one template. A title supplied through a wrapper component in another file is not visible to this rule and would report a false positive — it is sound here only because this repo composes overlays inline.
- The `hlmField` wrapping convention for form controls is not checked at all, on purpose; an earlier, broader version of this rule enforced it and was found to block legitimate non-form controls like a toolbar search input.
- It only checks for the presence of the title attribute, not that the title text is meaningful or that the element carrying it is a real heading — an empty `<span hlmDialogTitle></span>` satisfies the rule.

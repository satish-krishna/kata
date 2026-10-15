# The sealing spec (Part 1)

The single written contract that both the gate and the structural counter encode, independently and in different engines. The gate parses templates with angular-eslint; the counter parses them with Angular's own compiler (`@angular/compiler`). Neither shares code with the other. This document is the only place the rules are stated in prose; if the two encodings ever disagree on a fixture, this file is the arbiter, and one of the encodings is wrong.

## The rules are the docs, mechanized

Every rule here comes from a doc in the agent's baseline: SpartanNG's own documentation (the spartan skill, `rules/styling.md` and `rules/composition.md`), Angular's generated `CLAUDE.md`, and this repo's house-style skill (`.claude/skills/house-style`, the grid/flex grammar and no-raw-literals rule that extend spartan where it is silent). The gate enforces exactly what those docs say and permits everything they permit; where two baseline docs pull differently (Angular endorses style bindings, spartan wants appearance in tokens), the rule is drawn so it fights neither. This is not our stricter opinion bolted on top: the whole thesis is that the model drifts even with those docs in its context, so the gate is only an honest test if it blocks what the docs block and nothing more. Each rule below cites the docs line it mechanizes and lists the docs' own good and bad examples, which are the test cases the counter and gate must satisfy.

## The vocabulary, as installed

Read from source, not from memory. This list is derived from the `selector:` declarations in `libs/ui` at this substrate commit, which is the only honest definition of what the repo owns. The capstone widened `libs/ui` from three primitives to nineteen, and this section is the record of that widening; the rules below are exactly as wide as it and no wider.

Primitive attribute directives:

`hlmBtn`, `hlmInput`, `hlmTextarea`, `hlmLabel`, `hlmSeparator`, `hlmSkeleton`, `hlmBadge`, `hlmTooltip`,
`hlmCard`, `hlmCardHeader`, `hlmCardFooter`, `hlmCardTitle`, `hlmCardDescription`, `hlmCardContent`, `hlmCardAction`,
`hlmTable`, `hlmTableContainer`, `hlmTHead`, `hlmTBody`, `hlmTFoot`, `hlmTr`, `hlmTh`, `hlmTd`, `hlmCaption`, `hlmTableHeader`, `hlmTableBody`, `hlmTableFooter`, `hlmTableRow`, `hlmTableHead`, `hlmTableCell`, `hlmTableCaption`,
`hlmField`, `hlmFieldContent`, `hlmFieldDescription`, `hlmFieldGroup`, `hlmFieldLabel`, `hlmFieldTitle`, `hlmFieldSet`, `hlmFieldLegend`,
`hlmSelect`, `hlmSelectGroup`, `hlmSelectLabel`, `hlmSelectMultiple`, `hlmSelectPlaceholder`, `hlmSelectPortal`, `hlmSelectSeparator`, `hlmSelectValue`, `hlmSelectValues`, `hlmSelectValuesContent`, `hlmSelectValueTemplate`,
`hlmDialogClose`, `hlmDialogDescription`, `hlmDialogFooter`, `hlmDialogHeader`, `hlmDialogOverlay`, `hlmDialogPortal`, `hlmDialogTitle`, `hlmDialogTrigger`, `hlmDialogTriggerFor`,
`hlmSheetClose`, `hlmSheetDescription`, `hlmSheetFooter`, `hlmSheetHeader`, `hlmSheetOverlay`, `hlmSheetPortal`, `hlmSheetTitle`, `hlmSheetTrigger`,
`hlmTabs`, `hlmTabsContent`, `hlmTabsContentLazy`, `hlmTabsList`, `hlmTabsTrigger`,
`hlmAvatarBadge`, `hlmAvatarFallback`, `hlmAvatarGroup`, `hlmAvatarGroupCount`, `hlmAvatarImage`,
`hlmSwitchThumb`,
`hlmSidebarContent`, `hlmSidebarFooter`, `hlmSidebarGroup`, `hlmSidebarGroupAction`, `hlmSidebarGroupContent`, `hlmSidebarGroupLabel`, `hlmSidebarHeader`, `hlmSidebarInput`, `hlmSidebarInset`, `hlmSidebarMenu`, `hlmSidebarMenuAction`, `hlmSidebarMenuBadge`, `hlmSidebarMenuButton`, `hlmSidebarMenuItem`, `hlmSidebarMenuSkeleton`, `hlmSidebarMenuSub`, `hlmSidebarMenuSubButton`, `hlmSidebarMenuSubItem`, `hlmSidebarRail`, `hlmSidebarSeparator`, `hlmSidebarTrigger`, `hlmSidebarWrapper`.

Primitive element names:

`hlm-card`, `hlm-card-header`, `hlm-card-footer`,
`hlm-badge`, `hlm-separator`, `hlm-skeleton`,
`hlm-avatar`, `hlm-avatar-badge`, `hlm-avatar-group`, `hlm-avatar-group-count`,
`hlm-field`, `hlm-field-content`, `hlm-field-description`, `hlm-field-error`, `hlm-field-group`, `hlm-field-label`, `hlm-field-separator`, `hlm-field-title`,
`hlm-select`, `hlm-select-content`, `hlm-select-group`, `hlm-select-item`, `hlm-select-label`, `hlm-select-multiple`, `hlm-select-placeholder`, `hlm-select-scroll-down`, `hlm-select-scroll-up`, `hlm-select-separator`, `hlm-select-trigger`, `hlm-select-value`, `hlm-select-values-content`,
`hlm-dialog`, `hlm-dialog-content`, `hlm-dialog-footer`, `hlm-dialog-header`, `hlm-dialog-overlay`,
`hlm-sheet`, `hlm-sheet-content`, `hlm-sheet-footer`, `hlm-sheet-header`, `hlm-sheet-overlay`,
`hlm-tabs`, `hlm-tabs-list`, `hlm-paginated-tabs-list`,
`hlm-switch`,
`hlm-sidebar`, `hlm-sidebar-content`, `hlm-sidebar-footer`, `hlm-sidebar-group`, `hlm-sidebar-header`, `hlm-sidebar-menu-badge`, `hlm-sidebar-menu-skeleton`, `hlm-sidebar-separator`, `hlm-sidebar-wrapper`.

The set of primitive attribute names and element names is used by `no-appearance-on-primitive` and `no-unknown-primitive` to decide whether an element is a primitive.

`<ng-icon>` is deliberately NOT in this set. It is an `@ng-icons` element, not a Helm primitive, and spartan's own `rules/icons.md` explicitly blesses appearance classes on it (`class="text-muted-foreground"` for a decorative icon, `class="text-[length:--spacing(4)]"` for sizing). Treating it as a primitive would make `no-appearance-on-primitive` fight a baseline doc, which the whole design forbids. Icons get their own rule instead, [no-raw-icon](rules/no-raw-icon.md), and that rule bans only the thing no doc endorses.

## The rules

Every Part 1 violation is one of exactly six kinds. `no-unknown-primitive` and `no-missing-composition-part` were added after the capstone run, in response to drift it measured getting past the first four; they were not tested by that run, and the report says so. The gate reports them by `messageId`; the counter tallies them by `kind`. The kind strings are the shared vocabulary and must match on both sides.

| Rule | What it forbids |
| --- | --- |
| [no-raw-control](rules/no-raw-control.md) | A native control element used where a spartan primitive exists |
| [no-appearance-on-primitive](rules/no-appearance-on-primitive.md) | An appearance-override class on a primitive |
| [no-style-attribute](rules/no-style-attribute.md) | A static inline style attribute |
| [no-raw-icon](rules/no-raw-icon.md) | A raw inline `<svg>` in an application template |
| [no-unknown-primitive](rules/no-unknown-primitive.md) | An `hlm*` attribute or element matching no installed selector |
| [no-missing-composition-part](rules/no-missing-composition-part.md) | An overlay primitive present but not composed with its required title |

`no-unportalled-overlay` is deliberately gate-only. It has no counter kind, so the two engines do not cross-check each other on it and its `messageId` maps to no `kind` in the tally. That is a decision, not an oversight: the counter's job is measuring drift across experimental trials, and the runtime half of this question is already covered by `check-interaction.mjs`, which clicks every overlay trigger and asserts the overlay opens, dismisses, and logs no console error. If trials resume, the counter needs a `REQUIRED_PORTAL` table, an `unportalled-overlay` key in `emptyTotals`, a downward walk from the container for content not wrapped in a template carrying the portal, plus the  even `toEqual` totals blocks in `counter.test.mjs` and a fixture pair.

## Where customization goes (why the seal is with the grain, not against it)

Because Helm code is copied into the project, the documented way to customize a component is to edit its file in `libs/ui` (adjust the `cva` variants, change classes, add inputs) or to use its `variant`/`size` inputs, never to reach past it at the call site. The gate ignores `libs/**` entirely, so that customization path is fully open. `no-appearance-on-primitive` does not fight the framework; it enforces the framework's own "class is for layout only," and it points appearance changes at the place the docs point them.

## The tally shape (the counter's output contract)

```json
{
  "totals": { "raw-control": 0, "appearance-on-primitive": 0, "style-attribute": 0, "raw-icon": 0, "unknown-primitive": 0, "missing-composition-part": 0, "all": 0 },
  "violations": [
    { "kind": "raw-control", "file": "src/app/dashboard/dashboard.ts", "line": 12, "detail": "button without hlmBtn" }
  ]
}
```

`totals.all` is the sum of the six kinds. `violations` is ordered by file, then line, then kind, so the same input always serializes byte-identically. That ordering is what makes the determinism self-test (same committed diff in, identical tally out) meaningful.

## What each engine parses

- The gate loads angular-eslint's template parser and runs six custom rules over the template AST, on `.html` templates and inline `template:` strings.
- The counter loads `@angular/compiler`'s `parseTemplate` and walks the AST, reading `.html` files and extracting inline `template:` strings from `.ts` with the TypeScript compiler API. It shares no rule code, no parser, and no AST types with the gate.

One parser fact both engines need, stated here rather than discovered twice: both the angular-eslint template parser and `@angular/compiler` namespace SVG element nodes, so an inline `<svg>` arrives with the node name `:svg:svg`, not `svg`. This is a fact about the parsers, identical on both sides, not a shared implementation.

Two engines, one spec, and the spec is the docs. If they ever disagree, that disagreement is the finding.

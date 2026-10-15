# no-unportalled-overlay

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `unportalledOverlay`. Counter kind: `unportalled-overlay`.

## What it forbids

An overlay content element rendered as a plain child of its container instead of on the structural portal directive the overlay requires:

| container | content | required portal |
| --- | --- | --- |
| `hlm-select` | `hlm-select-content` | `*hlmSelectPortal` |
| `hlm-dialog` | `hlm-dialog-content` | `*hlmDialogPortal` |
| `hlm-sheet` | `hlm-sheet-content` | `*hlmSheetPortal` |

## Why

The portal is not decoration and it is not a styling wrapper. `HlmSelectPortal` and its siblings wrap `BrnOverlayContent`, whose constructor injects a `TemplateRef` and calls `registerContent(...)` on the overlay. That constructor only runs when the directive is applied with `*` syntax, because `*` is what desugars the content into an `<ng-template>` for the `TemplateRef` to point at.

Write the content as a plain child and two things happen, neither of them an error you will see:

1. `BrnOverlay._content` is never set. `open()` begins `if (!this._content) return;`, so clicking the trigger silently does nothing. The overlay can never open.
2. The un-templated content renders anyway, as an ordinary permanent DOM node. Its classes are open/closed *animation* utilities with no display gating, so the option list or dialog body sits visible inline on the page and in the accessibility tree.

This compiles, renders, passes every lint rule, passes every drift counter, and passes a render-only boot check. During the Hero Ops Console build, three `hlm-select` elements shipped this way on the Settings screen with four counters at zero, 42 tests passing and `check:boot --route settings` green. It was found by a reviewer reading the markup against the documentation.

The project's own capstone report names this defect class as the source of every fatal defect it measured, and observes that no AST rule reaches them. This rule is the AST rule that reaches this part of them.

## Accepted form

    <hlm-select [value]="vm.theme()" (valueChange)="vm.setTheme($event)">
      <hlm-select-trigger buttonId="theme-select">
        <hlm-select-value placeholder="Select a theme" />
      </hlm-select-trigger>
      <hlm-select-content *hlmSelectPortal>
        @for (option of vm.themeOptions; track option.value) {
          <hlm-select-item [value]="option.value">{{ option.label }}</hlm-select-item>
        }
      </hlm-select-content>
    </hlm-select>

## Agent guidance

The content element of an overlay always carries the portal. If you are writing `hlm-select-content`, `hlm-dialog-content` or `hlm-sheet-content`, it takes `*hlmSelectPortal`, `*hlmDialogPortal` or `*hlmSheetPortal` respectively — with the asterisk.

    Good: <hlm-dialog-content *hlmDialogPortal>
    Bad:  <hlm-dialog-content>

## Known blind spots

- It checks the three overlay families installed in this project. A future overlay primitive with its own portal is invisible to it until added to the table, exactly as `no-raw-control` was blind to `hlmTabsTrigger` until that was added to its own table.
- It only sees content nested somewhere beneath its container element in the same template. Content extracted into a separate component and projected in is not reachable from this walk.
- It verifies the portal is present, never that the overlay actually opens. A portal correctly applied to an overlay that fails for some other reason still passes. The runtime half of this question belongs to `check-interaction.mjs`, which clicks every trigger and asserts an overlay appears and dismisses.

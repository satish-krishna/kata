# no-unregistered-icon

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `unregisteredIcon`. Counter kind: `unregistered-icon`.

## What it forbids

A file that imports one or more named glyph symbols from `@ng-icons/lucide` and never calls `provideIcons(...)` anywhere in that file. Reported once per file, at the first offending import.

## Why

Spartan's `rules/icons.md`: "Icon names are not global - each icon you reference must be provided to the component (or app) via `provideIcons`." The parenthetical "(or app)" is the whole design of this rule, and the first draft got it wrong.

That first draft keyed on the component decorator: `NgIcon` in `imports` with no `provideIcons` in `providers`. It reads plausibly and it is wrong, because registering every glyph once in `app.config.ts` is a documented, sensible pattern, and a component relying on it correctly has no `provideIcons` of its own. Run against the capstone builds, that draft fired 7 times on one build and 4 on another — and those two were precisely the builds where icons WORKED. A rule written to catch a fatal icon bug would have blocked the only builds that shipped icons correctly.

The property that actually separates the cases is not where `NgIcon` is imported but where the glyph SYMBOLS go. A file that imports a glyph and never registers it has dead or misrouted imports; a file relying on app-level registration imports no glyph at all. One capstone trial imported eleven glyphs and handed them to `{ provide: 'ICONS', useValue: {...} }`, which typechecks, registers nothing, and left every icon in the shell blank. That property is decidable from the file's own AST with no cross-file join, and it fires on the real drift while staying silent on both correct patterns.

## Accepted form

    // Pattern A: registered locally
    import { NgIcon, provideIcons } from '@ng-icons/core';
    import { lucideUsers } from '@ng-icons/lucide';

    @Component({
      imports: [NgIcon],
      providers: [provideIcons({ lucideUsers })],
      template: `<ng-icon name="lucideUsers" />`,
    })

    // Pattern B: registered at app level, no lucide import in this file
    @Component({
      imports: [NgIcon],
      template: `<ng-icon name="lucideUsers" />`,
    })

## Agent guidance

Icons: import the standalone NgIcon, never NgIconsModule, and register every
icon the component renders with provideIcons. Copy this exact shape:

  import { NgIcon, provideIcons } from '@ng-icons/core';
  import { lucideUsers } from '@ng-icons/lucide';

  @Component({
    imports: [NgIcon],
    providers: [provideIcons({ lucideUsers })],
    template: `<ng-icon name="lucideUsers" />`,
  })

Do NOT import NgIconsModule (throws at bootstrap), and do NOT register an icon
through a custom token or a plain object (registers nothing): only provideIcons
registers an icon.

Read the house-style skill's icons section for the full example.

## Known blind spots

- What stays ungated is the join in the other direction: that every `<ng-icon name="X">` names a registered `X`. A name can be computed (`[name]="'lucide' + icon()"`) and is then not statically knowable, so this rule cannot and does not check it.
- The check is file-scoped: `provideIcons` anywhere in the file satisfies it, even a `provideIcons` call that registers a completely different, unrelated set of glyphs than the ones imported. The rule does not verify that the registered names and the imported names match.
- Only named imports from `@ng-icons/lucide` are tracked. A glyph imported from a different icon package, or re-exported through a local barrel file, is not recognized as an icon import by this rule.

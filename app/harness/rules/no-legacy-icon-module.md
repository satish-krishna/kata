# no-legacy-icon-module

> Plane: component shape. Index: [../component-shape-spec.md](../component-shape-spec.md). messageId: `legacyIconModule`. Counter kind: `legacy-icon-module`.

## What it forbids

`NgIconsModule` listed in a `@Component`'s `imports` array.

## Why

The house-style skill: "Import `NgIcon`, never `NgIconsModule`," layered on spartan's `rules/icons.md`, which shows only the standalone `NgIcon` import. This is the same AST shape as the `FormsModule` half of [no-forms-module](no-forms-module.md) and the `ReactiveFormsModule` half of [no-reactive-form](no-reactive-form.md).

This is the rule whose absence was fatal. Bare `NgIconsModule` throws at bootstrap ("No icons have been provided...") and takes the whole application down with a blank page while compiling perfectly, so three of the capstone's six builds compiled cleanly, passed `strictTemplates`, passed every AST gate that existed at the time, and rendered a blank page. `NgIconsModule` was always the legacy API, so the limitation was not undocumented — but the lesson is that a documented gap is still a gap until something actually mechanizes it.

## Accepted form

    import { NgIcon, provideIcons } from '@ng-icons/core';
    import { lucideUsers } from '@ng-icons/lucide';

    @Component({
      imports: [NgIcon],
      providers: [provideIcons({ lucideUsers })],
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

- Textual match on the `imports` array, like [no-forms-module](no-forms-module.md): an aliased import or a spread-hidden `NgIconsModule` is not resolved.
- The rule only bans the module import; it has nothing to say about whether icons are actually registered correctly once `NgIcon` is used instead — that is [no-unregistered-icon](no-unregistered-icon.md)'s job.

# no-legacy-control-flow

> Plane: freeloader. Index: [../freeloader-spec.md](../freeloader-spec.md). messageId: `legacyControlFlow`. Counter kind: `legacy-control-flow`.

## What it forbids

An element or `<ng-template>` carrying the structural directive `*ngIf`, `*ngFor`, or `*ngSwitch`. A structural directive desugars to a `Template` node in the parsed AST that carries the directive's name among its `templateAttrs`; the rule reads that list rather than pattern-matching the microsyntax attribute text directly.

## Why

Angular's own generated `CLAUDE.md` instructs native control flow (`@if`, `@for`, `@switch`) over the structural directives, and this rule mechanizes that line exactly — it is the framework's own stated preference, not an opinion added on top of it.

## Accepted form

    @if (x) { ... }
    @for (h of heroes(); track h.id) { ... }

## Agent guidance

Replace the structural directive with its native block equivalent.

    Good: @if (x) { ... }   @for (h of heroes(); track h.id) { ... }
    Bad:  <div *ngIf="x">   <li *ngFor="let h of heroes">

## Known blind spots

- Only the three named directives (`ngIf`, `ngFor`, `ngSwitch`) are checked. A custom structural directive, or `*ngTemplateOutlet`, is not covered.
- It only checks that the legacy directive is absent, not that the native block replacing it is well-formed — a missing `track` expression on `@for` is a template type error the compiler catches, not something this rule looks at.

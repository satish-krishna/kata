# no-ng-class-style

> Plane: freeloader. Index: [../freeloader-spec.md](../freeloader-spec.md). messageId: `ngClassStyle`. Counter kind: `ng-class-style`.

## What it forbids

An `ngClass` or `ngStyle`, in either form: a bound input (`[ngClass]="..."`, `[ngStyle]="..."`) or a bare attribute (`ngClass`, `ngStyle`). The rule checks both an element's plain attributes and its bound inputs, so neither form escapes it.

## Why

Angular's own generated `CLAUDE.md` states the preference directly — `class`/`style` bindings over `ngClass`/`ngStyle` — and this rule mechanizes that line exactly, with no independent argument added on top.

## Accepted form

    <div [class.active]="isActive()">
    <div [style.width.px]="w()">

## Agent guidance

Replace `ngClass`/`ngStyle` with a `class`/`style` binding.

    Good: <div [class.active]="isActive()">
    Bad:  <div [ngClass]="{ active: isActive() }">

## Known blind spots

- A static, literal `style="..."` attribute is not this rule's concern at all — that is `no-style-attribute` on the sealing plane. This rule only ever reaches `ngStyle` and `ngClass` by name.
- It checks only that `ngClass`/`ngStyle` is absent, not that the replacement binding is correct — a `[class.active]` bound to the wrong expression still passes this rule.

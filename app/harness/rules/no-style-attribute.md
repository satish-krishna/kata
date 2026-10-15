# no-style-attribute

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `styleAttribute`. Counter kind: `style-attribute`.

## What it forbids

A static, literal `style="..."` attribute on an element.

## Why

This rule is deliberately narrow, because two baseline docs pull in different directions here. Angular's own `CLAUDE.md` says to prefer `[style]` bindings over `[ngStyle]`, so the gate must not ban style bindings — doing so would fight a doc the agent is reading in the same session. What no baseline doc endorses is a static `style="..."` attribute: a raw inline literal that bypasses the token system entirely, against both spartan's "semantic tokens only" line and the house no-raw-literals rule. So the rule bans exactly the static attribute and nothing that looks like a binding.

## Accepted form

    <div [style.width.%]="pct()">
    <div [style]="computedStyles()">

## Agent guidance

Never write a literal `style="..."` attribute. If the value is genuinely static, it belongs in the stylesheet as a token; if it varies, use a `[style]` or `[style.x]` binding.

    Good: <div [style.width.%]="pct()">
    Bad:  <div style="color: red; padding: 8px">

## Known blind spots

- `[ngStyle]` is also discouraged by the same Angular baseline doc, but banning it is `no-ng-class-style`'s job on the freeloader plane, not this rule's — this rule only ever looks at the literal `style` attribute.
- A binding that carries a hardcoded literal, such as `[style.color]="'red'"`, passes this rule. It is bound syntax, so it is out of scope here, even though it is no less a raw literal than the attribute form.
- Raw color and length literals inside a component's own stylesheet (`styles: []` or a `styleUrl` file) are a different rule entirely, enforced by stylelint on the layout plane, not by this one.

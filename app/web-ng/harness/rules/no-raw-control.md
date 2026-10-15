# no-raw-control

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `rawControl`. Counter kind: `raw-control`.

## What it forbids

A native control element used where a spartan primitive exists for it.

Two shapes of violation:

- Most native elements have a directive twin. Any **one** of the listed attributes on the element satisfies the rule, because several Helm directives style the same native element in different compositions — `<button hlmBtn>` and `<button hlmSidebarMenuButton>` are both acceptable buttons.
- Two elements, `<select>` and `<dialog>`, have no directive twin at all. No attribute makes them acceptable; the element itself must be replaced with `<hlm-select>` or `<hlm-dialog>`.

## Why

The primitive vocabulary is sealed. A raw `<button>` is not a styling variation on `<button hlmBtn>` — it is outside the vocabulary, so it inherits no variant system, no focus ring, and no accessible defaults. The sealing plane exists because "looks close enough" is not a property a reviewer can check but is a property a parser can.

## Accepted form

    <button hlmBtn variant="ghost">Save</button>
    <input hlmInput />
    <textarea hlmTextarea></textarea>
    <hlm-select> ... </hlm-select>

## Agent guidance

Compose from spartan primitives. Change a primitive's look with its `variant`/`size` inputs or its Helm file in `libs/ui`, never a class at the call site.

    Good: <button hlmBtn variant="ghost">Save</button>   <input hlmInput />   <select> -> <hlm-select>
    Bad:  <button>Save</button>   <select>

## Known blind spots

- A native element inside a `<ng-template>` that is never rendered still reports. That is deliberate: dead markup is still markup a later edit can wake up.
- The rule checks attribute *presence*, not that the attribute is bound correctly. `<button hlmBtn>` with a broken input binding passes this rule and is caught by `strictTemplates` instead.
- A hand-built tab strip made of `<button hlmBtn>` satisfies this rule and is still an accessibility failure — there is no `role="tablist"` check anywhere in this harness. See the capstone report's accessibility section.

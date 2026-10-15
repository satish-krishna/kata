# no-unknown-primitive

> Plane: sealing. Index: [../sealing-spec.md](../sealing-spec.md). messageId: `unknownPrimitive`. Counter kind: `unknown-primitive`.

## What it forbids

An `hlm*` attribute or `hlm-*` element that matches no installed selector, checked in the exact form it is written. Every Helm primitive is either an attribute directive or an element, never both, and which one it is is fixed by its `selector:` in `libs/ui`. The rule is a closed-world check against that installed inventory: an attribute matching `/^hlm[A-Z]/` or `/^hlm-/` is checked against the attribute set, and an element matching `/^hlm-/` is checked against the element set, each strictly in that form.

The attribute-versus-element distinction is the whole point of the rule. `hlmSelectTrigger` written as an attribute is a violation even though `hlm-select-trigger` is a real, installed element — writing the right name in the wrong form is exactly the failure this rule exists to catch, so it does not treat the two forms as interchangeable.

## Why

A name that looks like a primitive but matches no real selector is not a compile error and not a runtime error. Angular treats an unmatched attribute on a native element as a plain HTML attribute: the markup compiles, renders, and silently does nothing. Across three gate-on capstone trials, 17 sites wrote a primitive that bound to nothing this way — every `hlm-select` in two trials had a non-functional trigger, and one trial had no sidebar component at all despite appearing to use one, with hand-written CSS re-implementing the rail it thought it already had. Every other seal rule reported clean, because `no-raw-control` only asks whether a native element carries a primitive attribute and `no-appearance-on-primitive` only classifies classes on elements it already believes are primitives — markup that merely *looks* like the vocabulary was invisible to the rest of the seal. This rule is the only one that checks membership in the vocabulary itself, which is why it must be read from `libs/ui` at each substrate commit rather than from memory.

## Accepted form

    <hlm-select-trigger>...</hlm-select-trigger>
    <hlm-avatar>...</hlm-avatar>
    <span hlmAvatarFallback>AB</span>

## Agent guidance

Check the installed vocabulary from source (the house-style skill, and "The vocabulary, as installed" in the sealing spec) before writing an `hlm*` name, and write it in the form its `selector:` actually declares — attribute or element, never guessed.

    Good: <hlm-select-trigger>...</hlm-select-trigger>
    Bad:  <button hlmBtn hlmSelectTrigger>...</button>

## Known blind spots

- A name outside the `hlm` namespace is never considered, so an ordinary HTML attribute or a third-party component selector is untouched by design.
- The check is only as current as the vocabulary list it is compiled against. A Helm primitive added to `libs/ui` without a matching update to that list would false-positive as unknown, and one removed without an update would false-negative as known; the rule trusts the list, it does not derive it live.
- It only asks whether the name exists. Whether a primitive that does exist is composed correctly — given the descendants it requires — is `no-missing-composition-part`'s job, not this one's.

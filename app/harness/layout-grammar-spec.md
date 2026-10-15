# The layout-grammar spec (Part 2)

The written contract for Part 2, encoded twice and independently: by the gate (angular-eslint for templates, stylelint for stylesheets) and by the counter (Angular's own compiler for templates, a separate scan for stylesheets). This file is the arbiter if the two disagree. Read `sealing-spec.md` first; Part 2 builds on the sealed vocabulary.

## The rules are the docs, mechanized

Same principle as Part 1: every rule comes from a doc in the agent's baseline, and the gate enforces exactly what those docs say. Two sources feed Part 2:

- **SpartanNG's styling docs** (the spartan skill): semantic colors only, and `gap-*` not `space-*`.
- **The house-style skill** (`.claude/skills/house-style`): the layout grammar (grid for regions, flex for inline runs, no nested flex faking a grid) and the no-raw-literals rule for hand-written CSS. These extend spartan where it is silent; they do not contradict it. They are written as a skill in the agent's baseline precisely so the gate mechanizes a doc the agent can read, not a rule smuggled in at the gate.

Two rules from the first cut of this spec were deleted because they fought the docs, not extended them: `presentation-on-raw` flagged `<div class="bg-card border-border border">`, which the spartan styling docs give as the good pattern, and the blanket arbitrary-bracket ban flagged `sm:max-w-[425px]`, which the spartan composition docs use. Neither survives. The hand-rolled-div-card that avoids the vocabulary is a composition problem, Part 3 ("use the component"), not a layout one.

## The measurement model (decided): cumulative baseline

By Part 2 the Part 1 sealing hook is baseline: on in both conditions. The single variable Part 2 moves is the layout rules. gate-off is sealing only; gate-on is sealing plus the layout gate. The baseline (spartan skill and MCP, Angular's `CLAUDE.md`, and now the house-style skill) is identical in both conditions and present in both.

## The rules

| Rule | What it forbids |
| --- | --- |
| [no-raw-palette-color](rules/no-raw-palette-color.md) | A raw Tailwind palette or hex color instead of a semantic token |
| [no-space-utility](rules/no-space-utility.md) | `space-x-*`/`space-y-*` instead of `gap-*` |
| [no-nested-flex-grid](rules/no-nested-flex-grid.md) | A flex row of flex columns, which lays out as a grid written as nested flex |

### `raw-css-literal`: a raw color or length in a hand-written stylesheet

Docs: the house-style skill, "No raw literals in hand-written CSS." In an inline `styles: []` block or a `styleUrl` file, a color or length must be a token (`var(--...)`), never a raw hex, `rgb()`/`hsl()`, or `px`. This is scoped to hand-written CSS, where spartan is silent (it assumes Tailwind utilities); it does not touch spartan's blessed template brackets.

- Violation: `background: #3b82f6`, `padding: 16px`, `color: rgb(0 0 0)`. Good: `background: var(--card)`, `padding: var(--spacing-4)`, `border: 1px solid var(--border)` where the color is a token (a bare structural `1px` border width is the edge case).
- The gate enforces this with stylelint's `declaration-strict-value` (colors and spacing must resolve to a `var()`), a genuinely different engine from the counter's scan.

This kind has no `harness/gate/rules/*.ts` file and no per-rule doc, because it is not an ESLint rule at all — angular-eslint does not lint CSS, so the entire check lives in the stylelint config. This section is its only written contract.

## The tally shape

```json
{
  "totals": { "raw-palette-color": 0, "space-utility": 0, "raw-css-literal": 0, "nested-flex-grid": 0, "all": 0 },
  "violations": [ { "kind": "raw-palette-color", "file": "src/app/dashboard/dashboard.ts", "line": 18, "detail": "bg-blue-500" } ]
}
```

A full audit runs both counters (Part 1 kinds and Part 2 kinds) and reports both, because the series is cumulative.

## What each engine parses

- Templates: the gate uses angular-eslint; the counter uses `@angular/compiler`. No shared code.
- Stylesheets: the gate uses stylelint (a postcss AST); the counter uses its own text scan. Genuinely different engines, so their agreement is a real cross-check, not a tautology.

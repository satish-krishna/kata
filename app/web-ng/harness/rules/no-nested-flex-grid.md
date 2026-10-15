# no-nested-flex-grid

> Plane: layout. Index: [../layout-grammar-spec.md](../layout-grammar-spec.md). messageId: `nestedFlexGrid`. Counter kind: `nested-flex-grid`.

## What it forbids

A flex container that is a row (carries `flex` but not `flex-col`) with two or more direct children that are themselves `flex flex-col`. A row of columns. A flex column containing flex rows — the opposite direction — is not flagged.

## Why

This rule did not exist as a hard gate until the capstone, and the reason is worth keeping because the rule was wrong for five prior measurement rounds. The house-style skill states the anti-pattern directionally: "a ROW of flex COLUMNS, each itself a flex stack, arranged to line up into a grid, is the anti-pattern." The first implementation judged this undecidable from classes alone and settled for a loose, direction-blind proxy — any flex container with two or more flex children — kept as a counter-only heuristic, never gated.

The capstone ran that proxy over seven complete builds and it flagged 63 sites. One of them was the actual anti-pattern. The other 62 were overwhelmingly a `flex flex-col` card body containing a header row and a content row — a column of rows, which is not a grid, is not two-dimensional, and is the single most ordinary layout in the language. The doc sentence had the discriminator in it the whole time: a row of columns reads as a grid, a column of rows is a stack. The rule was never undecidable, only unencoded, and once written to check direction it flagged exactly one site across the same seven builds. It is now hard-gated because it is decidable and precise, not because the anti-pattern grew more important.

One consequence cost a headline and is recorded rather than absorbed quietly: an earlier capstone report cited `nested-flex-grid` rising 13 to 32 under gate-on, alongside every enforced kind falling to zero, and read that rise as drift displacing into the one dimension left unenforced. Under the corrected, direction-aware rule both arms are zero. What had actually risen was benign card markup caught by the direction-blind proxy. The displacement claim did not survive and was retracted. A finding built on a proxy is only as good as the proxy.

## Accepted form

    <div class="flex flex-col">
      <div class="flex justify-between">Header</div>
      <div class="flex flex-col">Content</div>
    </div>

## Agent guidance

Use `grid grid-cols-* gap-*` for a genuinely two-dimensional region. Keep `flex` for single-axis runs — a flex column of flex rows, or a flex row of flex rows, is fine.

    Good: <div class="flex flex-col"><div class="flex justify-between">Header</div><div class="flex flex-col">Content</div></div>
    Bad:  <div class="flex justify-between"><div class="flex flex-col">Power</div><div class="flex flex-col">Missions</div></div>

## Known blind spots

- Only direct children are checked. A row of columns separated from the row by one intervening wrapper element is invisible to this rule.
- It requires at least two qualifying children; a row with exactly one `flex flex-col` child alongside a non-flex sibling does not trip it, even if the same visual grid effect were achieved with column-count one.
- It matches Tailwind class names, not rendered geometry. It cannot tell a deliberate row of independently-stacked widgets from a grid written as nested flex if both happen to carry the same utility classes — the doc's directional rule is the only discriminator it has.

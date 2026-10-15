import noRawPaletteColor from './rules/no-raw-palette-color.ts';
import noSpaceUtility from './rules/no-space-utility.ts';
import noNestedFlexGrid from './rules/no-nested-flex-grid.ts';

// The `layout` eslint plugin: the Part 2 template rules, mechanizing spartan's
// styling docs (semantic colors only, gap not space). Independent of the counter
// (angular-eslint parser vs the counter's @angular/compiler). messageIds map:
//   rawPaletteColor -> raw-palette-color
//   spaceUtility    -> space-utility
//   nestedFlexGrid  -> nested-flex-grid
// The raw-css-literal rule is enforced by stylelint in the layout hook, not
// here (angular-eslint does not lint CSS).
//
// nested-flex-grid was counter-only for five Parts on the grounds that it was
// too noisy to hard-block an edit. It was: as a proxy. The capstone showed the
// proxy was not what the doc said (the doc's sentence is directional, a ROW of
// COLUMNS), and once encoded faithfully it flagged 1 site across seven builds
// instead of 63. Decidable and precise, so now gated.
const plugin = {
  meta: { name: 'layout', version: '1.0.0' },
  rules: {
    'no-raw-palette-color': noRawPaletteColor,
    'no-space-utility': noSpaceUtility,
    'no-nested-flex-grid': noNestedFlexGrid,
  },
};

export default plugin;

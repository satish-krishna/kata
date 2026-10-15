// The worked-example correctives for the component-shape gate, generated from
// the fired rules' own '## Agent guidance' section rather than kept as inline
// copies. A gate rejection is the highest-salience teaching moment the agent
// gets, so it hands back the documented right pattern, not just the
// violation - Part 3's gate-on-guided A/B measured this: swapping a prose
// reminder for a worked example took house-pattern use from 0/3 to 3/3. The
// markdown in harness/rules/ is now the single source of truth for that text;
// reading it here means the hook text and the doc cannot drift apart.
//
// Exported names and *_RULE_IDS sets are unchanged from before this file was
// repointed, so check-component-shape.mjs needs no change beyond its import.
import { agentGuidanceFor } from './rule-docs.mjs';

// A doc's url follows the generated meta.docs.url convention exactly:
// harness/rules/<rule-name>.md, where <rule-name> is the ruleId with its
// plugin prefix stripped. Building the pointer this way (rather than running
// eslint) lets these constants exist as plain, eagerly-evaluated exports.
function docsPointerFor(ruleId) {
  return { ruleId, url: `harness/rules/${ruleId.split('/').pop()}.md` };
}

// One guidance block per topic: every rule in the set shares the identical
// worked example in its doc today, so agentGuidanceFor's dedup-by-body
// collapses them to a single block and joining that one-element array is
// byte-identical to taking its first element. Joining rather than taking
// `[0]` matters only if a doc in the set is ever edited independently: dedup
// then stops collapsing, and taking `[0]` would silently hand the agent one
// rule's guidance for a violation of a different rule in the same set, with
// no error. Joining degrades that failure mode to "the agent sees every
// block that fired" instead of "the agent sees the wrong one".
function guidanceFor(ruleIds) {
  const blocks = agentGuidanceFor([...ruleIds].map(docsPointerFor));
  if (blocks.length === 0) return '';
  return '\n' + blocks.join('\n\n');
}

// The messageIds/ruleIds whose fix is the forms worked example. The other
// shape rules (change detection, subscribe, presentational inject) carry
// their own one-line fix in the rule message and do not need the form snippet.
export const FORMS_RULE_IDS = new Set([
  'shape/no-reactive-form',
  'shape/no-forms-module',
  'shape/no-restated-validator',
  'shape/no-ng-model',
]);

// The messageIds/ruleIds whose fix is the MVVM worked example.
export const MVVM_RULE_IDS = new Set([
  'shape/no-root-provided-view-model',
  'shape/no-state-outside-view-model',
  'shape/no-feature-inject-data',
  'shape/no-unprovided-view-model',
]);

// The messageIds/ruleIds whose fix is the icon worked example.
export const ICON_RULE_IDS = new Set(['shape/no-legacy-icon-module', 'shape/no-unregistered-icon']);

// The messageIds/ruleIds whose fix is the submit worked example.
export const SUBMIT_RULE_IDS = new Set(['shape/no-orphan-ng-submit']);

export const SHAPE_FORMS_GUIDANCE = guidanceFor(FORMS_RULE_IDS);
export const MVVM_GUIDANCE = guidanceFor(MVVM_RULE_IDS);
export const ICON_GUIDANCE = guidanceFor(ICON_RULE_IDS);
export const SUBMIT_GUIDANCE = guidanceFor(SUBMIT_RULE_IDS);

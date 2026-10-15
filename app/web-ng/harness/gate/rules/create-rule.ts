// The single RuleCreator for every gate rule. The URL function derives the
// docs pointer from the rule's own name, so `harness/rules/no-raw-control.md`
// cannot drift out of sync with `no-raw-control.ts` the way a hand-written
// string would. ESLint core never dereferences this: it is inert metadata,
// reachable only through eslint.getRulesMetaForResults(). What makes it reach
// the agent is the hook change in Task 3, not this line.
//
// A repo-relative path rather than an https:// URL, deliberately. The two
// consumers are a human in an editor and an agent under test; the agent has a
// file-reading tool and no browser, and this repo is private, so a URL would be
// worthless to exactly the reader the docs are for.
import { ESLintUtils } from '@typescript-eslint/utils';

export const createRule = ESLintUtils.RuleCreator(
  (name: string) => `harness/rules/${name}.md`,
);

// The browser mock's own model of a change, which its fixtures are written in and `sdlc-mock.ts` turns into
// the `ChangeView` the backend sends. It is the shape the backend's own change read had before the plugin
// owned the workflow; no backend type mirrors it any more, so it lives here, with the fixtures, and not in
// `@bindings`. Specs that describe a change by its stage use `Stage` from here too.

/** Where a change is in the intent, spec, plan flow. */
export type Stage = 'intent-in-progress' | 'intent-awaiting' | 'intent-accepted-uncommitted' | 'rejected' | 'spec-ready' | 'spec-awaiting' | 'spec-accepted-uncommitted' | 'plan-ready' | 'plan-awaiting' | 'plan-accepted-uncommitted' | 'plan-out-of-date' | 'plan-unreadable' | 'plan-superseded' | 'build-ready' | 'build-stopped' | 'build-finished' | 'fix-in-progress' | 'fix-unsettled' | 'fix-awaiting' | 'fix-accepting' | 'fix-needs-plugin';

/** Which pipeline a change is on: the full intent, spec, plan flow, or the light track a fix takes. */
export type Track = 'full' | 'fix';

/** One document of a change. `status` is the front matter's; `head_status` is the `HEAD` copy's, for a fix. */
export type DocState = { exists: boolean; committed: boolean; status: string | null; head_status: string | null };

/** Task counts of a change's plan against its build logs. */
export type BuildCounts = { tasks: number; finished: number; repos: number };

/** Why an accepted or written plan cannot be built, earliest document first. */
export type OutOfDate = 'intent-reopened' | 'spec-reopened' | 'spec-pin' | 'plan-pin' | 'no-tasks';

/** One change as a fixture describes it. */
export type ChangeInfo = {
  system: string;
  change: string;
  intent: DocState;
  spec: DocState;
  plan: DocState;
  stage: Stage;
  build: BuildCounts;
  scope: string;
  out_of_date: OutOfDate | null;
  /** The plan could not be read, so its tasks and build counts are unknown. */
  plan_unreadable: boolean;
  /** Why, when `plan_unreadable`; null otherwise. */
  plan_unreadable_reason: string | null;
  track: Track;
  /** The row of the fix-state table a fix stands at; null for a full-pipeline change. */
  fix_row: number | null;
};

/** One task of a fixture's plan. */
export type PlanTask = { id: string; name: string; repo: string; dependsOn: string[] };

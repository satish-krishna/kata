import type { ChangeKey } from '@bindings/ChangeKey';
import type { RunForm } from '@bindings/RunForm';
import type { RunKind } from '@bindings/RunKind';
import type { RunSpec } from '@bindings/RunSpec';

/** The document runs of a change that exists, which `sdlcRunChange` launches: the kinds of `RunKind` that compose a run-spec of a change without building. */
export type DocumentKind = Extract<RunKind, 'intent' | 'spec' | 'plan' | 'triage' | 'fix'>;

/** Whether two keys the backend gave name the same change. */
export const sameChange = (a: ChangeKey, b: ChangeKey): boolean =>
  a.workspace.key === b.workspace.key && a.system === b.system && a.change === b.change;

/** The time limit of a document run that sets none. */
export const DOCUMENT_TIMEOUT_SECS = 6 * 60 * 60;

/** What the backend composes a document run from: the run's name and task, the permission setting, the limit and the items the engineer left on. The preview and the launch send the same form. */
export const documentForm = (spec: RunSpec): RunForm => ({
  name: spec.name,
  task: spec.task,
  permissionMode: spec.permissions.mode,
  timeoutSecs: spec.leash.timeout_secs ?? DOCUMENT_TIMEOUT_SECS,
  bare: false,
  given: spec.given ?? undefined,
});

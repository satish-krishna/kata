import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { RunForm } from '@bindings/RunForm';
import type { RunKind } from '@bindings/RunKind';
import type { RunSpec } from '@bindings/RunSpec';

/** The document runs of a change that exists, which `sdlcRunChange` launches: the kinds of `RunKind` that compose a run-spec of a change without building. */
export type DocumentKind = Extract<RunKind, 'intent' | 'spec' | 'plan' | 'triage' | 'fix'>;

/** The workspace folder as the backend's key spells it: separators unified, trailing separators dropped, lower case. */
const folderKey = (folder: string): string => folder.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/** Whether a build announcement is about this change: same workspace, system and change name. */
export const isChange = (key: ChangeKey, ref: ChangeRef): boolean =>
  key.workspace.key === folderKey(ref.workspace) && key.system === ref.system && key.change === ref.change;

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

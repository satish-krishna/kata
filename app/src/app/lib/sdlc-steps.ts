import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RecordedPullRequest } from '@bindings/RecordedPullRequest';
import type { StepKind } from '@bindings/StepKind';

/** A long step of a change that runs now: what it is doing, and what its Stop button says it stops. */
export interface StepView {
  label: string;
  stop: string;
}

/** A long step of a change that runs now, with the latest label the backend reported for it. */
export interface ChangeStep {
  change: ChangeKey;
  kind: StepKind;
  label: string;
}

/** The long steps the pages show a label and Stop for; `preparing` is a build's or a review's preparation. */
export type StepWant = 'preparing' | 'starting' | 'renaming' | 'removingCopy' | 'accepting' | 'rejecting' | 'declaringDone';

/** Whether a step report is about the kind of step `want` (the document of an accepting or rejecting step does not matter: a change runs one at a time). */
export function isStep(kind: StepKind, want: StepWant): boolean {
  // A rejected fix is its own kind of step, so the backend can say "fix" in its words; it is still a rejecting step.
  if (want === 'preparing') return kind === 'preparingBuild' || kind === 'preparingReview';
  if (typeof kind === 'string') return kind === want || (kind === 'rejectingFix' && want === 'rejecting');
  return want in kind;
}

/**
 * Whether a step report's change key names the change `ref` names. The key's workspace is a normalized path the backend computes and the
 * page holds the raw folder, so the workspace is not compared here; system and change are.
 */
export function sameStepChange(key: ChangeKey, ref: { system: string; change: string }): boolean {
  return key.system === ref.system && key.change === ref.change;
}

/** The backend's answer, when it gave one, after a colon. */
const withAnswer = (said: string, answer: string[]): string => (answer.length === 0 ? said : `${said}: ${answer.join(' ')}`);

/** A stopped accepting: whether the plugin had committed the acceptance when it stopped. */
export function acceptStopped(doc: ChangeDocument, accepted: boolean): string {
  return accepted ? `Stopped. The ${doc} is accepted; its checks did not finish` : `Stopped. The ${doc} was not accepted`;
}

/** A stopped rejecting: whether the plugin had committed the rejection when it stopped. A light-track change is rejected as a `fix`. */
export function rejectStopped(doc: 'intent' | 'fix', rejected: boolean): string {
  return rejected ? `Stopped. The ${doc} is rejected; its copy was not removed` : `Stopped. The ${doc} was not rejected`;
}

/** A stopped rename, with the workflow's answer when it gave one. */
export function renameStopped(answer: string[]): string {
  return withAnswer('Stopped. The rename did not finish', answer);
}

/** A stopped start, with the workflow's answer when it gave one. */
export function startStopped(answer: string[]): string {
  return withAnswer('Stopped. The start did not finish', answer);
}

/** A stopped removal of a copy, naming what was kept when the plugin said. */
export function removalStopped(kept: string[]): string {
  return kept.length === 0 ? 'Stopped. The removal did not finish' : `Stopped. The removal did not finish. Kept: ${kept.join(', ')}`;
}

/** A stopped declaring done: the pull requests the plugin had opened when it stopped. */
export function doneStopped(pullRequests: RecordedPullRequest[]): string {
  return pullRequests.length === 0 ? 'Stopped. Nothing was pushed or opened' : `Stopped. Pull request opened for ${pullRequests.map((p) => p.repo).join(', ')}`;
}

/** The steps the change page shows: everything a change does but its preparation, which the build page owns. */
export const CHANGE_STEPS: readonly StepWant[] = ['starting', 'renaming', 'removingCopy', 'accepting', 'rejecting', 'declaringDone'];

/** The steps the home shows: the ones it starts itself. */
export const HOME_STEPS: readonly StepWant[] = ['starting', 'removingCopy'];

/** The running step of the change `change` names, of one of the kinds `wants`; null when there is none. Steps of other changes are never picked. */
export function stepOf(running: readonly ChangeStep[], change: { system: string; change: string }, wants: readonly StepWant[]): ChangeStep | null {
  return running.find((s) => sameStepChange(s.change, change) && wants.some((w) => isStep(s.kind, w))) ?? null;
}

/** What the Stop button of a step says it stops. */
export function stopWords(kind: StepKind): string {
  if (typeof kind === 'string') {
    switch (kind) {
      case 'preparingBuild':
      case 'preparingReview':
        return 'Stop preparing the build';
      case 'starting':
        return 'Stop starting the change';
      case 'renaming':
        return 'Stop renaming the branch';
      case 'removingCopy':
        return 'Stop removing the copy';
      case 'rejectingFix':
        return 'Stop rejecting the fix';
      case 'declaringDone':
        return 'Stop declaring the change done';
    }
  }
  return 'accepting' in kind ? `Stop accepting the ${kind.accepting}` : `Stop rejecting the ${kind.rejecting}`;
}

/** The step's own change as a call names it, in the workspace folder the page holds. What Stop sends: the step's change, never whichever change is current. */
export function stepRef(step: ChangeStep, workspace: string): ChangeRef {
  return { workspace, system: step.change.system, change: step.change.change };
}

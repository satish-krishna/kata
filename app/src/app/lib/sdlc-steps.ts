import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RecordedPullRequest } from '@bindings/RecordedPullRequest';
import type { StepKind } from '@bindings/StepKind';

/** A long step of a change that runs now: what it is doing, and what its Stop button says it stops. */
export interface StepView {
  label: string;
  stop: string;
}

/** The long steps the change page and the home show a label and Stop for. */
export type StepWant = 'starting' | 'renaming' | 'removingCopy' | 'accepting' | 'rejecting' | 'declaringDone';

/** Whether a step report is about the kind of step `want` (the document of an accepting or rejecting step does not matter: a change runs one at a time). */
export function isStep(kind: StepKind, want: StepWant): boolean {
  return typeof kind === 'string' ? kind === want : want in kind;
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

/** A stopped rejecting: whether the plugin had committed the rejection when it stopped. */
export function rejectStopped(doc: ChangeDocument, rejected: boolean): string {
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

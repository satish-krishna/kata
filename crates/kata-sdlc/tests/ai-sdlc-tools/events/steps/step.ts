// The shape of an event's built-in step, the plugin's own work that runs between the event's before and after hooks,
// and, for steps that need the hooks' results first, after them.
import type { Hook, HookConfig, OnFailure } from '../config.ts';
import type { EventContext } from '../context.ts';
import type { HookRecord } from '../ledger.ts';

/**
 * What a step's work found. `failed` names a check behind a problem and what it asks for, as a failed hook would;
 * `outcome` says when a problem is a fault of the machine (`could-not-run`) rather than of the work.
 */
export type StepResult = { problems: string[]; details?: Record<string, unknown>; failed?: { id: string; onFailure: OnFailure; output: string }; outcome?: 'failed' | 'could-not-run' };

/**
 * Decides a before hook's result. `allow` false on a failure stops the event with `problem` (or the usual one) and
 * `onFailure` (or the hook's own); `allow` true lets a failure through. It is called for every result, passed ones
 * included, so it can note a check the change fixed.
 */
export type Judge = (hook: Hook, record: HookRecord) => { allow: boolean; problem?: string; onFailure?: OnFailure };

export type Step = {
  /** Preconditions, checked before any hook runs. A problem refuses the event and nothing runs. */
  check?(ctx: EventContext): string[] | Promise<string[]>;
  /** The plugin's own work, after the before hooks pass. A problem fails the event and the after hooks do not run. */
  act?(ctx: EventContext): Promise<StepResult> | StepResult;
  /** Work after the after hooks, such as build.start's baseline, which needs what those hooks installed. A problem fails the event. */
  finish?(ctx: EventContext, config: HookConfig): Promise<StepResult> | StepResult;
  /**
   * Work before the before hooks, such as build.finish's baseline. A problem fails the event before any hook runs.
   * Its `judge`, when given, decides each before hook's result: a failure it allows does not stop the event.
   */
  prepare?(ctx: EventContext, config: HookConfig): Promise<StepResult & { judge?: Judge }>;
  /** What a result is about, for the ledger: the repository's head unless the step says otherwise. */
  key?(ctx: EventContext): string;
  /** What a result is about within its key: the document of doc.accept, the task of task.done. */
  subject?(ctx: EventContext): string | null;
  /** Whether a run that passed at the same key and subject is reused rather than run again. */
  reusePassed: boolean;
};

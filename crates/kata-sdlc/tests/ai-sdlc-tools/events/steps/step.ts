// The shape of an event's built-in step, the plugin's own work that runs between the event's before and after hooks.
import type { EventContext } from '../context.ts';

export type StepResult = { problems: string[]; details?: Record<string, unknown> };

export type Step = {
  /** Preconditions, checked before any hook runs. A problem refuses the event and nothing runs. */
  check?(ctx: EventContext): string[] | Promise<string[]>;
  /** The plugin's own work, after the before hooks pass. A problem fails the event and the after hooks do not run. */
  act?(ctx: EventContext): Promise<StepResult> | StepResult;
  /** What a result is about, for the ledger: the repository's head unless the step says otherwise. */
  key?(ctx: EventContext): string;
  /** What a result is about within its key: the document of doc.accept, the task of task.done. */
  subject?(ctx: EventContext): string | null;
  /** Whether a run that passed at the same key and subject is reused rather than run again. */
  reusePassed: boolean;
};

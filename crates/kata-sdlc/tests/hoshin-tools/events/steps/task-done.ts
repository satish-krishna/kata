// task.done: fired by the build after each task's commit in its product repository. It has no work of its own.
import type { Step } from './step.ts';

export const taskDone: Step = {
  reusePassed: true,
  check: (ctx) => (/^T\d+$/.test(ctx.extra.task ?? '') ? [] : ['task.done needs --task T<n>']),
  subject: (ctx) => ctx.extra.task ?? null,
};

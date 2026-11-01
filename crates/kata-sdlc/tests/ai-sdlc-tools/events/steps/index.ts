// Every event's built-in step. An event with no file here has no work of its own yet: only its hooks run.
import type { EventName } from '../config.ts';
import { buildFinish } from './build-finish.ts';
import { buildStart } from './build-start.ts';
import { changeDone } from './change-done.ts';
import { changeStart } from './change-start.ts';
import { docAccept } from './doc-accept.ts';
import { reviewFinish } from './review-finish.ts';
import type { Step } from './step.ts';
import { taskDone } from './task-done.ts';

export const STEPS: Record<EventName, Step> = {
  'change.start': changeStart,
  'doc.accept': docAccept,
  'build.start': buildStart,
  'task.done': taskDone,
  'build.finish': buildFinish,
  'review.finish': reviewFinish,
  'change.done': changeDone,
};

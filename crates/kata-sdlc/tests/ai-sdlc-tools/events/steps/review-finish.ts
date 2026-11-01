// review.finish: fired by the review skill after it commits a review. It has no work of its own.
import type { Step } from './step.ts';

export const reviewFinish: Step = { reusePassed: true };

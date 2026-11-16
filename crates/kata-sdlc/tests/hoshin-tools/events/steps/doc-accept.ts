// doc.accept: fired when an acceptance gate passes for intent.md, spec.md or plan.md (references/workspace.md,
// section 9), or when the fix skill commits its acceptances. It has no work of its own: it is where a team's hooks
// run on an accepted document. A result is about the commit that accepted the document, so it runs once per acceptance.
import { join } from 'node:path';
import { gitOut } from '../../git/git.ts';
import type { EventContext } from '../context.ts';
import type { Step } from './step.ts';

const DOCUMENTS = ['intent.md', 'spec.md', 'plan.md'];

const documentOf = (ctx: EventContext): string => ctx.extra.document ?? '';

export const docAccept: Step = {
  reusePassed: true,
  check(ctx) {
    const doc = documentOf(ctx);
    if (!DOCUMENTS.includes(doc)) return [`doc.accept needs --document intent.md, spec.md or plan.md`];
    if (gitOut(ctx.master, ['log', '-1', '--format=%H', '--', join(ctx.folder, doc)]) === '') return [`${doc} of ${ctx.change} is not committed`];
    return [];
  },
  key: (ctx) => gitOut(ctx.master, ['log', '-1', '--format=%H', '--', join(ctx.folder, documentOf(ctx))]) ?? '',
  subject: documentOf,
};

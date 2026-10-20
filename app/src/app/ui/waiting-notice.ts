import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';

/** One run of the build that waits on the engineer: where, for what, and how long it will wait (null when it has no deadline). */
export type WaitingItem = { repo: string; kind: 'answer' | 'approval'; countdown: string | null };

/* A notice that an agent waits on the engineer, one per waiting run. It cannot be dismissed: it goes when the run stops waiting.
 * `compact` is the one-line banner shown over another repository's activity. It carries no text the agent wrote. */
@Component({
  selector: 'app-waiting-notice',
  imports: [HlmButtonImports],
  templateUrl: './waiting-notice.html',
})
export class WaitingNotice {
  readonly items = input.required<WaitingItem[]>();
  readonly compact = input(false);
  readonly goTo = output<string>();
}

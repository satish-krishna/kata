import { Component, input, output } from '@angular/core';

/** One run of the build that waits on the engineer: where, for what, and how long it will wait. */
export type WaitingItem = { repo: string; kind: 'answer' | 'approval'; countdown: string | null };

@Component({
  selector: 'app-waiting-notice',
  templateUrl: './waiting-notice.html',
})
export class WaitingNotice {
  readonly items = input.required<WaitingItem[]>();
  readonly compact = input(false);
  readonly goTo = output<string>();
}

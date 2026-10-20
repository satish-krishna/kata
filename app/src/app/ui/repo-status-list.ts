import { Component, input, output } from '@angular/core';

export type RepoRowTone = 'success' | 'warning' | 'error' | 'idle';
/** One repository's row (or the review's): its name, andon status as a dot plus label, and its clocks. */
export type RepoRow = { name: string; tone: RepoRowTone; label: string; clock: string | null; paused: string | null };

@Component({
  selector: 'app-repo-status-list',
  templateUrl: './repo-status-list.html',
})
export class RepoStatusList {
  readonly rows = input.required<RepoRow[]>();
  readonly selected = input<string | null>(null);
  readonly select = output<string>();
}

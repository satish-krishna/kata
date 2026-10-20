import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';

export type RepoRowTone = 'success' | 'warning' | 'error' | 'idle';
/** One repository's row (or the review's): its name, andon status as a dot plus label, and its clocks. */
export type RepoRow = { name: string; tone: RepoRowTone; label: string; clock: string | null; paused: string | null };

/* The build's left column: a row per repository the plan names, then the review. Picking a row says whose runs the main column shows. */
@Component({
  selector: 'app-repo-status-list',
  imports: [HlmButtonImports],
  templateUrl: './repo-status-list.html',
})
export class RepoStatusList {
  readonly rows = input.required<RepoRow[]>();
  readonly selected = input<string | null>(null);
  readonly select = output<string>();
}

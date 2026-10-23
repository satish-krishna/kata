import { Component, input, output } from '@angular/core';
import type { BuildRow } from '@bindings/BuildRow';
import type { StageAction } from '../../lib/sdlc';
import type { Pick } from '../../lib/build-sessions';
import type { BuildChanges, BuildPageView } from './build-page.view-model';

/* The build page: tasks, activity and changed files side by side, with the waiting notice and the action bar above them.
 * It draws one `BuildPageView` and holds no state of the build. */
@Component({
  selector: 'app-build-page',
  templateUrl: './build-page.html',
})
export class BuildPage {
  readonly view = input.required<BuildPageView>();
  readonly context = input<BuildChanges | null>(null);
  readonly turns = input(0);
  readonly rows = input<BuildRow[]>([]);
  readonly task = input<{ id: string; repo: string } | null>(null);
  readonly stopped = input<string[]>([]);

  readonly pick = output<Pick>();
  readonly repoAction = output<{ repo: string; action: 'cancel' | 'continue' }>();
  readonly act = output<StageAction>();
  readonly answer = output<{ runId: string; id: string; answers: string[][] }>();
  readonly decide = output<{ runId: string; id: string; allow: boolean; message: string | null }>();
  readonly goTo = output<string>();
  readonly toggleRun = output<string>();
}

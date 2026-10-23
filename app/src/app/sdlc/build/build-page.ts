import { Component, input, model, output } from '@angular/core';
import type { BuildRow } from '@bindings/BuildRow';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmResizableImports } from '@spartan-ng/helm/resizable';
import type { Pick } from '../../lib/build-sessions';
import { actionLabel, primaryAction, type StageAction } from '../../lib/sdlc';
import { FindingsList } from '../../ui/findings-list';
import { ObservePane } from '../../ui/observe-pane';
import { Segmented } from '../../ui/segmented';
import { WaitingNotice } from '../../ui/waiting-notice';
import { ChangesView } from '../changes/changes-view';
import type { BuildChanges, BuildPageView } from './build-page.view-model';

/** The areas of the build page the narrow switch chooses between. */
export type Panel = 'tasks' | 'activity' | 'files';

const TASKS = { value: 'tasks', label: 'Tasks' } as const;
const ACTIVITY = { value: 'activity', label: 'Activity' } as const;
const FILES = { value: 'files', label: 'Files' } as const;
const ALL: { value: Panel; label: string }[] = [TASKS, ACTIVITY, FILES];
const NO_FILES: { value: Panel; label: string }[] = [TASKS, ACTIVITY];
const NO_ACTIVITY: { value: Panel; label: string }[] = [TASKS, FILES];
const ONLY_TASKS: { value: Panel; label: string }[] = [TASKS];

/* The build page: the waiting notice and the action bar above three areas side by side, the tasks, the activity of what the
 * engineer picked, and the changed files. It draws one `BuildPageView` and holds no state of the build; the host does the work
 * its outputs ask for. An area with nothing to show is not drawn and its room goes to the others. Below 1024 CSS pixels
 * (`view.narrow`) the areas share one column behind a switch; the ones not on show are hidden, never removed. */
@Component({
  selector: 'app-build-page',
  host: { class: 'block h-full min-h-0' },
  providers: [provideIcons({ lucideChevronDown, lucideChevronRight })],
  imports: [HlmButtonImports, HlmResizableImports, NgIcon, FindingsList, ObservePane, Segmented, WaitingNotice, ChangesView],
  templateUrl: './build-page.html',
  styleUrl: './build-page.css',
})
export class BuildPage {
  readonly view = input.required<BuildPageView>();
  readonly context = input<BuildChanges | null>(null);
  readonly turns = input(0);
  readonly rows = input<BuildRow[]>([]);
  readonly task = input<{ id: string; repo: string } | null>(null);
  readonly stopped = input<string[]>([]);
  /** The area on show while the page is narrow. */
  readonly panel = model<Panel>('activity');

  readonly pick = output<Pick>();
  readonly repoAction = output<{ repo: string; action: 'cancel' | 'continue' }>();
  readonly act = output<StageAction>();
  readonly answer = output<{ runId: string; id: string; answers: string[][] }>();
  readonly decide = output<{ runId: string; id: string; allow: boolean; message: string | null }>();
  readonly goTo = output<string>();
  readonly toggleRun = output<string>();

  protected readonly labelOf = actionLabel;

  protected primary(): StageAction | null {
    return primaryAction(this.view().actions);
  }

  /** The areas the switch offers: only those with something to show. */
  protected options(): { value: Panel; label: string }[] {
    const { activity, files } = this.view().areas;
    return activity ? (files ? ALL : NO_FILES) : files ? NO_ACTIVITY : ONLY_TASKS;
  }

  /** The area on show while narrow: the one chosen, else the tasks when the one chosen is not drawn. */
  protected on(): Panel {
    const wanted = this.panel();
    return this.options().some((o) => o.value === wanted) ? wanted : 'tasks';
  }

  /** A pick moves a narrow page to the activity it picked. */
  protected choose(pick: Pick): void {
    this.pick.emit(pick);
    this.panel.set('activity');
  }

  protected goToRepo(repo: string): void {
    this.goTo.emit(repo);
    this.panel.set('activity');
  }
}

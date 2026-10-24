import { Component, ElementRef, Injector, afterNextRender, effect, inject, input, model, output, untracked } from '@angular/core';
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
import type { AreaId, LayoutMode, Place } from '../../lib/build-layout';
import type { ArrangeAction, BuildLayoutState } from './build-layout.view-model';
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

/* The widths of the areas side by side, in percent, for each set that is drawn. The group is told them whenever the set changes, because
 * left alone it shares the room by the order the areas appeared in, and the changed files, which come last, ended up the narrowest. */
const SIDE_BY_SIDE = [22, 39, 39];
const WITHOUT_FILES = [36, 64];
const WITHOUT_ACTIVITY = [36, 64];
const ALONE = [100];

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
  /** The layout as the layout view model has it. */
  readonly layout = input.required<BuildLayoutState>();
  readonly context = input<BuildChanges | null>(null);
  readonly turns = input(0);
  readonly rows = input<BuildRow[]>([]);
  readonly task = input<{ id: string; repo: string } | null>(null);
  readonly stopped = input<string[]>([]);
  /** A request to bring the picked repository's open question into view and focus it. */
  readonly focus = input<{ repo: string; n: number } | null>(null);
  /** The area on show while the page is narrow. */
  readonly panel = model<Panel>('activity');

  readonly pick = output<Pick>();
  readonly repoAction = output<{ repo: string; action: 'cancel' | 'continue' }>();
  readonly act = output<StageAction>();
  /** The bar's Cancel build: stops every run, which needs no preview and no confirmation. */
  readonly cancelBuild = output<void>();
  readonly answer = output<{ runId: string; id: string; answers: string[][] }>();
  readonly decide = output<{ runId: string; id: string; allow: boolean; message: string | null }>();
  readonly goTo = output<string>();
  readonly toggleRun = output<string>();
  readonly pickMode = output<LayoutMode>();
  readonly arrange = output<ArrangeAction>();
  readonly focusOn = output<AreaId>();
  readonly unfocus = output<void>();
  readonly flip = output<{ place: Place; area: AreaId }>();
  /** The room the grid has, in pixels, whenever it changes. */
  readonly room = output<{ width: number; height: number }>();

  protected readonly labelOf = actionLabel;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    // A Go to is asked of the view model; the DOM half (scroll and focus) waits until the picked repository's session is on show.
    effect(() => {
      const request = this.focus();
      if (request === null) return;
      untracked(() => afterNextRender(() => this.focusOpenCard(), { injector: this.injector }));
    });
  }

  /** Bring the open question or approval of the sessions on show into view and put the focus on its first control. */
  private focusOpenCard(): void {
    const cards = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-area="activity"] .k-ask:not(.k-ask--answered):not(.k-ask--lapsed)');
    const card = Array.from(cards).find((c) => c.closest('[hidden]') === null);
    if (card === undefined) return;
    card.scrollIntoView({ block: 'center' });
    card.querySelector<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]')?.focus();
  }

  /** A press on the bar: cancelling the build is the page's own, every other action is the host's. */
  protected press(action: StageAction): void {
    if (action === 'cancel-build') this.cancelBuild.emit();
    else this.act.emit(action);
  }

  protected primary(): StageAction | null {
    return primaryAction(this.view().actions);
  }

  /** How the group shares its width among the areas drawn; the same array for the same set, so the binding only moves when the set does. */
  protected widths(): number[] {
    const { activity, files } = this.view().areas;
    return activity ? (files ? SIDE_BY_SIDE : WITHOUT_FILES) : files ? WITHOUT_ACTIVITY : ALONE;
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

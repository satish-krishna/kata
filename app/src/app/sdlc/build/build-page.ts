import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, Injector, afterEveryRender, afterNextRender, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import type { BuildRow } from '@bindings/BuildRow';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronDown, lucideChevronRight, lucideEllipsis, lucideMaximize2, lucideMinus } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  MIN_MIDDLE_WIDTH,
  MIN_ROW_HEIGHT,
  MIN_SIDE,
  canTuck,
  whereIs,
  type AreaId,
  type Edge,
  type LayoutMode,
  type Place,
} from '../../lib/build-layout';
import { layoutKeyFor } from '../../lib/build-layout-keys';
import type { Pick } from '../../lib/build-sessions';
import { actionLabel, primaryAction, type Finding, type StageAction } from '../../lib/sdlc';
import { FindingsList } from '../../ui/findings-list';
import { ObservePane } from '../../ui/observe-pane';
import { Segmented } from '../../ui/segmented';
import { WaitingNotice } from '../../ui/waiting-notice';
import { ChangesView } from '../changes/changes-view';
import type { ArrangeAction, BuildLayoutState } from './build-layout.view-model';
import type { BuildChanges, BuildPageView } from './build-page.view-model';

type Side = Exclude<Place, 'middle'>;

/** The areas in the order the grid holds them, which never changes. */
const AREA_ORDER: AreaId[] = ['tasks', 'activity', 'files', 'findings'];
const AREA_NAMES: Record<AreaId, string> = { tasks: 'Tasks', activity: 'Activity', files: 'Changed files', findings: 'Findings' };
const MODE_NAMES: Record<LayoutMode, string> = { overview: 'Overview', watch: 'Watch', changes: 'Changes', review: 'Review' };
const MODE_ORDER: LayoutMode[] = ['overview', 'watch', 'changes', 'review'];
const PLACES: { place: Place; label: string }[] = [
  { place: 'left', label: 'Left' },
  { place: 'middle', label: 'Middle' },
  { place: 'right', label: 'Right' },
  { place: 'bottom', label: 'Bottom' },
];
const SIDES: Side[] = ['left', 'right', 'bottom'];
const EDGES: Edge[] = ['left', 'right', 'bottom'];
const SIZE_VARS: Record<Side, string> = { left: '--k-left', right: '--k-right', bottom: '--k-bottom' };

/* The grid has seven columns (left rail, left, separator, middle, separator, right, right rail) and four rows (the main row, a separator,
 * the bottom, the bottom rail). Every cell has a fixed line number; a place with nothing in it keeps a track of no size. */
const FULL = '1 / 1 / 5 / 8';
const CELLS: Record<Place, string> = { left: '1 / 2 / 2 / 3', middle: '1 / 4 / 2 / 5', right: '1 / 6 / 2 / 7', bottom: '3 / 1 / 4 / 8' };
const SEPARATOR_CELLS: Record<Side, string> = { left: '1 / 3 / 2 / 4', right: '1 / 5 / 2 / 6', bottom: '2 / 1 / 3 / 8' };
const RAIL_CELLS: Record<Edge, string> = { left: '1 / 1 / 2 / 2', right: '1 / 7 / 2 / 8', bottom: '4 / 1 / 5 / 8' };

/** What a press of an arrow key moves a focused separator by, in pixels; Shift makes it the larger step. */
const NUDGE = 16;
const NUDGE_FAR = 64;
const TUCK_NOTE = 'The page always shows at least one area.';

/* The build page: the waiting notice and the bar above four areas in one grid, the tasks, the activity of what the engineer picked,
 * the changed files and the findings. It draws one `BuildPageView` and one `BuildLayoutState` and holds no state of the build or the
 * layout; the host does the work its outputs ask for. The four areas are always in the grid, in the same order, so none is ever
 * removed or moved in the DOM: one that is not on show is inert and hidden by `content-visibility`, which keeps its scroll place
 * and its run panes folding. */
@Component({
  selector: 'app-build-page',
  host: { class: 'block h-full min-h-0' },
  providers: [provideIcons({ lucideCheck, lucideChevronDown, lucideChevronRight, lucideEllipsis, lucideMaximize2, lucideMinus })],
  imports: [HlmButtonImports, HlmDropdownMenuImports, NgIcon, NgTemplateOutlet, FindingsList, ObservePane, Segmented, WaitingNotice, ChangesView],
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
  /** Make an area visible, whatever has become of it. */
  readonly reveal = output<AreaId>();
  /** The engineer picked a finding that names a file. */
  readonly showFinding = output<Finding>();

  protected readonly areas = AREA_ORDER;
  protected readonly places = PLACES;
  protected readonly sides = SIDES;
  protected readonly edgeNames = EDGES;
  protected readonly tuckNote = TUCK_NOTE;
  protected readonly labelOf = actionLabel;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly grid = viewChild.required<ElementRef<HTMLElement>>('grid');
  /** The separator being dragged: DOM bookkeeping for the gesture, not state of the page. */
  private drag: { side: Side; from: number; size: number; px: number } | null = null;

  constructor() {
    // A Go to is asked of the view model; the DOM half (scroll and focus) waits until the picked repository's session is on show.
    effect(() => {
      const request = this.focus();
      if (request === null) return;
      untracked(() => afterNextRender(() => this.focusOpenCard(), { injector: this.injector }));
    });
    // Only the selected tab of a stack is in the tab order. BrnButton owns the tabindex of every hlmBtn and clears what a template sets, so it is set here.
    afterEveryRender(() => {
      for (const tab of this.host.nativeElement.querySelectorAll<HTMLElement>('[role="tab"]')) {
        const wanted = tab.getAttribute('aria-selected') === 'true' ? '0' : '-1';
        if (tab.getAttribute('tabindex') !== wanted) tab.setAttribute('tabindex', wanted);
      }
    });
    // The layout view model needs the room the grid has to keep the sides from crowding out the middle.
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1].contentRect;
        this.room.emit({ width: Math.round(box.width), height: Math.round(box.height) });
      });
      observer.observe(this.grid().nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Bring the open question or approval of the sessions on show into view and put the focus on its first control. */
  private focusOpenCard(): void {
    const cards = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-area="activity"] .k-ask:not(.k-ask--answered):not(.k-ask--lapsed)');
    const card = Array.from(cards).find((c) => c.closest('[hidden], [inert]') === null);
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

  protected choose(pick: Pick): void {
    this.pick.emit(pick);
  }

  /** A finding that names a file was picked: the changed files become visible first, then show its place. */
  protected pickFinding(finding: Finding): void {
    this.reveal.emit('files');
    this.showFinding.emit(finding);
  }

  protected goToRepo(repo: string): void {
    // The activity is made visible first, so the request to go to the repository finds it on show.
    this.reveal.emit('activity');
    this.goTo.emit(repo);
  }

  // ---- the layout ----

  /** True when the area's name carries the waiting mark: the activity, while any agent waits on the engineer. */
  protected marked(area: AreaId): boolean {
    return area === 'activity' && this.view().waiting.length > 0;
  }

  protected nameOf(area: AreaId): string {
    return AREA_NAMES[area];
  }

  protected modeName(mode: LayoutMode): string {
    return MODE_NAMES[mode];
  }

  /** The mode switcher's options; the one the build's stage suits carries the mark. */
  protected modes(): { value: LayoutMode; label: string; title: string; mark?: string }[] {
    const suggested = this.layout().suggested;
    return MODE_ORDER.map((m, i) => ({ value: m, label: MODE_NAMES[m], title: `${MODE_NAMES[m]} (Ctrl+${i + 1})`, ...(suggested === m ? { mark: 'suggested' } : {}) }));
  }

  /** Where the area is: a place, or `tucked`. */
  protected placeOf(area: AreaId): Place | 'tucked' {
    const where = whereIs(this.layout().drawn, area);
    return where.kind === 'place' ? where.place : 'tucked';
  }

  /** The side or middle an area's cell is in; a tucked area keeps the middle's cell. */
  protected stackPlace(area: AreaId): Place {
    const place = this.placeOf(area);
    return place === 'tucked' ? 'middle' : place;
  }

  /** The area's cell: the whole grid when it is in focus. */
  protected cellOf(area: AreaId): string {
    if (this.layout().focus === area) return FULL;
    return CELLS[this.stackPlace(area)];
  }

  protected shown(area: AreaId): boolean {
    return this.layout().onShow.includes(area);
  }

  /** The names in the area's stack, in order; a tucked area or one alone has none to flip between. */
  protected stackOf(area: AreaId): AreaId[] {
    const place = this.placeOf(area);
    return place === 'left' || place === 'right' || place === 'bottom' ? this.layout().drawn[place] : [area];
  }

  protected canTuckArea(area: AreaId): boolean {
    return canTuck(this.layout().drawn, area);
  }

  /** The count an area's name carries: the changed files, the findings. */
  protected countOf(area: AreaId): number {
    const counts = this.view().counts;
    return area === 'files' ? counts.files : area === 'findings' ? counts.findings : 0;
  }

  protected tuckedAt(edge: Edge): AreaId[] {
    return this.layout().drawn.tucked.filter((t) => t.edge === edge).map((t) => t.area);
  }

  /** True when the rails and the separators are drawn: not while one area fills the page. */
  protected showEdges(): boolean {
    return this.layout().focus === null;
  }

  protected columns(): string {
    const { drawn } = this.layout();
    const side = (place: 'left' | 'right') => (drawn[place].length > 0 ? `var(${SIZE_VARS[place]}, ${drawn.sizes[place]}px)` : '0');
    const divider = (place: 'left' | 'right') => (drawn[place].length > 0 ? '1px' : '0');
    const rail = (edge: 'left' | 'right') => (this.tuckedAt(edge).length > 0 ? 'auto' : '0');
    return [rail('left'), side('left'), divider('left'), 'minmax(0, 1fr)', divider('right'), side('right'), rail('right')].join(' ');
  }

  protected rowTracks(): string {
    const { drawn } = this.layout();
    const bottom = drawn.bottom.length > 0;
    return ['minmax(0, 1fr)', bottom ? '1px' : '0', bottom ? `var(${SIZE_VARS.bottom}, ${drawn.sizes.bottom}px)` : '0', this.tuckedAt('bottom').length > 0 ? 'auto' : '0'].join(' ');
  }

  protected railCell(edge: Edge): string {
    return RAIL_CELLS[edge];
  }

  protected separatorCell(side: Side): string {
    return SEPARATOR_CELLS[side];
  }

  /** The area on show in a side's stack. */
  private onShowAt(side: Side): AreaId {
    const { drawn, flipped } = this.layout();
    const wanted = flipped[side];
    return wanted !== undefined && drawn[side].includes(wanted) ? wanted : drawn[side][0];
  }

  protected separatorLabel(side: Side): string {
    return `Resize the ${AREA_NAMES[this.onShowAt(side)].toLowerCase()} and the middle`;
  }

  protected sizeOf(side: Side): number {
    return Math.round(this.layout().drawn.sizes[side]);
  }

  protected minSide(): number {
    return MIN_SIDE;
  }

  // ---- dragging a separator ----

  /** The most a side can have: what leaves the middle its minimum. Unknown (null) until the grid has been measured. */
  private maxSize(side: Side): number | null {
    const el = this.grid().nativeElement;
    const { drawn } = this.layout();
    if (side === 'bottom') return el.clientHeight > 0 ? el.clientHeight - MIN_ROW_HEIGHT : null;
    const other = side === 'left' ? 'right' : 'left';
    return el.clientWidth > 0 ? el.clientWidth - MIN_MIDDLE_WIDTH - (drawn[other].length > 0 ? drawn.sizes[other] : 0) : null;
  }

  private clampSize(side: Side, px: number): number {
    const max = this.maxSize(side);
    return Math.round(Math.max(MIN_SIDE, max === null ? px : Math.min(px, max)));
  }

  protected dragStart(event: PointerEvent, side: Side): void {
    const el = event.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function' && typeof event.pointerId === 'number') el.setPointerCapture(event.pointerId);
    const size = this.sizeOf(side);
    this.drag = { side, from: side === 'bottom' ? event.clientY : event.clientX, size, px: size };
  }

  /** Draw the new size through a CSS variable on the grid while the pointer moves; nothing is told to the page yet. */
  protected dragMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null) return;
    const delta = (drag.side === 'bottom' ? event.clientY : event.clientX) - drag.from;
    drag.px = this.clampSize(drag.side, drag.side === 'left' ? drag.size + delta : drag.size - delta);
    this.grid().nativeElement.style.setProperty(SIZE_VARS[drag.side], `${drag.px}px`);
  }

  /** The release tells the page the size once, and the variable goes when the page has drawn it. */
  protected dragEnd(): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    if (drag.px !== drag.size) this.arrange.emit({ kind: 'resize', side: drag.side, px: drag.px });
    const grid = this.grid().nativeElement;
    afterNextRender(() => grid.style.removeProperty(SIZE_VARS[drag.side]), { injector: this.injector });
  }

  /**
   * The keys of a focused separator: the arrow keys that move it toward the middle's far side make its area larger, the opposite pair make
   * it smaller, 16 pixels a press and 64 with Shift. Home goes to the smallest and End to the largest. Each press tells the page once; the
   * page clamps what it is told to the room, so End asks for as much as the grid measures, or for more than any room has when it is not measured yet.
   */
  protected nudge(event: KeyboardEvent, side: Side): void {
    const [grow, shrink] = side === 'bottom' ? ['ArrowUp', 'ArrowDown'] : side === 'left' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight'];
    const now = this.sizeOf(side);
    const step = event.shiftKey ? NUDGE_FAR : NUDGE;
    let px: number;
    if (event.key === grow) px = now + step;
    else if (event.key === shrink) px = now - step;
    else if (event.key === 'Home') px = MIN_SIDE;
    else if (event.key === 'End') px = Number.MAX_SAFE_INTEGER;
    else return;
    event.preventDefault();
    px = this.clampSize(side, px);
    if (px !== now) this.arrange.emit({ kind: 'resize', side, px });
  }

  // ---- the keys of the page ----

  /** Ctrl+1 to Ctrl+4 pick a mode; Esc ends a focus, and is left alone when nothing is in focus or something else has taken it. */
  protected onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const key = layoutKeyFor(event);
    if (key === null) return;
    if (key.kind === 'mode') {
      event.preventDefault();
      this.pickMode.emit(key.mode);
    } else if (this.layout().focus !== null) {
      event.preventDefault();
      this.unfocus.emit();
    }
  }

  /** The arrow keys, Home and End in a stack's tabs: the tab is picked as it takes the focus, and the focus follows to the area that comes on show. */
  protected tabKey(event: KeyboardEvent, tab: AreaId): void {
    const stack = this.stackOf(tab);
    const at = stack.indexOf(tab);
    const next =
      event.key === 'ArrowRight' ? stack[(at + 1) % stack.length]
      : event.key === 'ArrowLeft' ? stack[(at - 1 + stack.length) % stack.length]
      : event.key === 'Home' ? stack[0]
      : event.key === 'End' ? stack[stack.length - 1]
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    if (next === tab) return;
    this.flip.emit({ place: this.stackPlace(tab), area: next });
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>(`[data-area="${next}"] [role="tab"][aria-selected="true"]`)?.focus(),
      { injector: this.injector },
    );
  }
}

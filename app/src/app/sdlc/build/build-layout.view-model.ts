import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import {
  areasOnShow,
  bringBack,
  defaultArrangement,
  fitSizes,
  place,
  resize,
  tuck,
  whereIs,
  type AreaId,
  type Arrangement,
  type LayoutMode,
  type Place,
  type Room,
} from '../../lib/build-layout';
import { readLayoutFile, writeLayoutFile } from '../../lib/build-layout-file';
import { onStageChange, suitedMode, type LayoutStage } from '../../lib/build-layout-stage';
import { BuildPageViewModel } from './build-page.view-model';

/** One change to the arrangement of the mode on show. */
export type ArrangeAction =
  | { kind: 'place'; area: AreaId; to: Place }
  | { kind: 'tuck'; area: AreaId }
  | { kind: 'bring-back'; area: AreaId }
  | { kind: 'resize'; side: Exclude<Place, 'middle'>; px: number }
  | { kind: 'reset' };

/** What the build page draws of the layout, as one plain object. */
export type BuildLayoutState = {
  mode: LayoutMode;
  /** The mode's arrangement with the sizes that fit the room. */
  drawn: Arrangement;
  /** The areas on show: the focused one alone, else the middle and the top of each side stack. */
  onShow: AreaId[];
  focus: AreaId | null;
  flipped: Partial<Record<Place, AreaId>>;
  suggested: LayoutMode | null;
};

const MODES: LayoutMode[] = ['overview', 'watch', 'changes', 'review'];
const MODE_NAMES: Record<LayoutMode, string> = { overview: 'Overview', watch: 'Watch', changes: 'Changes', review: 'Review' };
const AREA_NAMES: Record<AreaId, string> = { tasks: 'Tasks', activity: 'Activity', files: 'Changed files', findings: 'Findings' };

const NONE: Record<LayoutMode, Arrangement | null> = { overview: null, watch: null, changes: null, review: null };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The arrangement of the build page: which mode is on show, what is in focus, the remembered arrangement of every mode and the
 * stage-driven suggestion. It lives as long as the change page, so the page's tabs never reset it. Only `arrange` writes the
 * layout file; everything else is page state that is gone with the page.
 */
@Injectable()
export class BuildLayoutViewModel {
  private readonly build = inject(BuildPageViewModel);
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);

  readonly mode = signal<LayoutMode>('overview');
  /** The area that fills the page, or null. */
  readonly focus = signal<AreaId | null>(null);
  /** The area shown for a place whose stack holds several. */
  readonly flipped = signal<Partial<Record<Place, AreaId>>>({});
  /** The mode marked as suited to the build's new stage, or null. */
  readonly suggested = signal<LayoutMode | null>(null);
  /** True once the engineer picked a mode during this stage, which keeps a stage change from moving the page. */
  readonly handSwitched = signal(false);
  /** The room the areas are drawn in; the page sets it. */
  readonly room = signal<Room>({ width: 1280, height: 800 });
  /** The remembered arrangement of every mode, null where there is none or it could not be used. */
  readonly saved = signal<Record<LayoutMode, Arrangement | null>>(NONE);

  /** The mode's arrangement as remembered, else its default. */
  readonly arrangement = computed<Arrangement>(() => this.saved()[this.mode()] ?? defaultArrangement(this.mode()));
  /** The arrangement with the sizes that fit the room; never written back. */
  readonly drawn = computed<Arrangement>(() => ({ ...this.arrangement(), sizes: fitSizes(this.arrangement(), this.room()) }));

  /** Everything the page draws, in one object. */
  readonly view = computed<BuildLayoutState>(() => ({
    mode: this.mode(),
    drawn: this.drawn(),
    onShow: areasOnShow(this.drawn(), this.flipped(), this.focus()),
    focus: this.focus(),
    flipped: this.flipped(),
    suggested: this.suggested(),
  }));

  /** The modes whose entry was in the file but unusable, until the page said so. */
  private readonly unusable = new Set<LayoutMode>();
  private openChange: string | null = null;
  private lastStage: LayoutStage;
  /** Resolves once the layout file has been read; writes wait for it so they never drop a mode that is still arriving. */
  private readonly ready: Promise<void>;

  constructor() {
    this.lastStage = untracked(() => this.build.layoutStage());
    this.ready = this.read();
    // A change other than the one open starts the page over for it; a reload of the same change does nothing.
    effect(() => {
      const change = this.build.loaded()?.ctx.change;
      if (change !== undefined && change !== untracked(() => this.openChange)) untracked(() => this.open(change));
    });
    // A new stage may move the page or mark the suited mode; nothing else does.
    effect(() => {
      const to = this.build.layoutStage();
      untracked(() => this.stageChanged(to));
    });
  }

  /** Read the layout file once; an error reading it gives four nulls. */
  private async read(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.transport.loadBuildLayout();
    } catch {
      return;
    }
    const read = readLayoutFile(raw);
    // A key in the file that reads as null is unusable; a missing key is simply not arranged.
    const entries = typeof raw === 'object' && raw !== null ? (raw as { modes?: unknown }).modes : undefined;
    if (typeof entries === 'object' && entries !== null) {
      for (const m of MODES) if (read[m] === null && m in entries) this.unusable.add(m);
    }
    // What was arranged while the file was being read stands.
    this.saved.update((now) => ({ ...read, ...Object.fromEntries(MODES.filter((m) => now[m] !== null).map((m) => [m, now[m]])) }));
    this.noteUnreadable(this.mode());
  }

  /** Say, once, that the mode's remembered entry could not be read. Returns the text for the announcement, or an empty string. */
  private unreadableNote(mode: LayoutMode): string {
    if (!this.unusable.delete(mode)) return '';
    return `The ${MODE_NAMES[mode]} layout could not be read; it is back to its default.`;
  }

  private noteUnreadable(mode: LayoutMode): void {
    const note = this.unreadableNote(mode);
    if (note !== '') this.build.say(note);
  }

  /** Show a mode: announce it, with the note that its entry was unusable the first time it shows. */
  private announceMode(mode: LayoutMode): void {
    this.build.say([`Layout: ${MODE_NAMES[mode]}.`, this.unreadableNote(mode)].filter((t) => t !== '').join(' '));
  }

  /** Open the page for a change: the mode suited to its stage, with nothing in focus, flipped, marked or switched by hand. */
  open(change: string): void {
    this.openChange = change;
    this.lastStage = this.build.layoutStage();
    this.focus.set(null);
    this.flipped.set({});
    this.suggested.set(null);
    this.handSwitched.set(false);
    const mode = suitedMode(this.lastStage);
    this.mode.set(mode);
    this.noteUnreadable(mode);
  }

  /** The engineer picked a mode. Focus ends and flips go. */
  pickMode(m: LayoutMode): void {
    if (m !== this.mode()) this.handSwitched.set(true);
    if (this.suggested() === m) this.suggested.set(null);
    this.focus.set(null);
    this.flipped.set({});
    this.mode.set(m);
    this.announceMode(m);
  }

  /** Change the arrangement of the mode on show, remember it and write the file. The only path that writes it. */
  arrange(action: ArrangeAction): void {
    const mode = this.mode();
    const a = this.arrangement();
    let next: Arrangement | null;
    switch (action.kind) {
      case 'place':
        next = place(a, action.area, action.to);
        this.flipped.update((f) => ({ ...f, [action.to]: action.area }));
        break;
      case 'tuck':
        next = tuck(a, action.area);
        break;
      case 'bring-back':
        next = bringBack(a, action.area);
        break;
      case 'resize':
        next = resize(a, action.side, action.px, this.room());
        break;
      case 'reset':
        next = null;
        break;
    }
    this.unusable.delete(mode);
    this.saved.update((s) => ({ ...s, [mode]: next }));
    void this.write();
  }

  private async write(): Promise<void> {
    try {
      await this.ready;
      const now = this.saved();
      const modes: Partial<Record<LayoutMode, Arrangement>> = {};
      for (const m of MODES) {
        const entry = now[m];
        if (entry !== null) modes[m] = entry;
      }
      await this.transport.saveBuildLayout(writeLayoutFile(modes));
    } catch (e) {
      this.toasts.error(`Could not save the layout: ${message(e)}`);
    }
  }

  focusOn(area: AreaId): void {
    this.focus.set(area);
    this.build.say(`Focus: ${AREA_NAMES[area]} fills the page.`);
  }

  unfocus(): void {
    this.focus.set(null);
    this.build.say(`Layout: ${MODE_NAMES[this.mode()]}.`);
  }

  flip(at: Place, area: AreaId): void {
    this.flipped.update((f) => ({ ...f, [at]: area }));
  }

  /** Make an area visible: end a focus on another area, bring a tucked area back, flip to an area behind another. */
  reveal(area: AreaId): void {
    const focus = this.focus();
    if (focus === area) return;
    if (focus !== null) this.unfocus();
    const where = whereIs(this.arrangement(), area);
    if (where.kind === 'tucked') this.arrange({ kind: 'bring-back', area });
    // A brought-back area joins the end of its stack and may sit behind another; so may one that never left a stack.
    if (areasOnShow(this.arrangement(), this.flipped(), null).includes(area)) return;
    const now = whereIs(this.arrangement(), area);
    if (now.kind === 'place') this.flip(now.place, area);
  }

  private stageChanged(to: LayoutStage): void {
    if (to === this.lastStage) return;
    const handSwitched = this.handSwitched();
    this.lastStage = to;
    this.handSwitched.set(false);
    this.suggested.set(null);
    const { move, suggested } = onStageChange({ to, mode: this.mode(), handSwitched });
    if (move !== null) {
      this.focus.set(null);
      this.flipped.set({});
      this.mode.set(move);
      this.announceMode(move);
    }
    if (suggested !== null) this.suggested.set(suggested);
  }
}

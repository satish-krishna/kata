import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { Part } from '@bindings/Part';
import type { PrState } from '@bindings/PrState';
import { prNumber } from '../../lib/pull-request';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import type { DiffLayout } from '../../ui/diff-bar';
import type { StepRequest } from '../../ui/diff-editor/diff-editor';
import type { FileRef, RepoFileGroup } from '../../ui/repo-file-list';

/** What the Changes view looks at: the workspace folder, its master repository, and the system's change. */
export type ChangesContext = { folder: string; masterRepo: string; system: string; change: string };

export const PART_OPTIONS: { value: Part; label: string }[] = [
  { value: 'whole', label: 'Whole change' },
  { value: 'committed', label: 'Committed' },
  { value: 'uncommitted', label: 'Uncommitted' },
];

/** Below this width the list stacks above the diff and the editor is always inline (Tailwind's `md` breakpoint). */
const NARROW = '(max-width: 767.98px)';
const NO_FILES: ChangedFile[] = [];
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How a reload treats the open file: leave it alone, show it for the new part, or keep up with it. */
type Reload = 'open' | 'part' | 'refresh';

/**
 * The state of the Changes view: the repositories with changes, the files of one part of the change in each, the
 * file being read, and what the compared base is. Everything here is read only; it calls the four diff reads
 * and nothing else. A refresh keeps the engineer's place: the same repository, part and file, with only that file's
 * new text handed to the editor.
 */
@Injectable()
export class ChangesViewModel {
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);

  private context: ChangesContext | null = null;
  /** Newer reloads supersede older ones still reading; picks have their own count so a pick never cancels a reload. */
  private seq = 0;
  private pickSeq = 0;
  private lastTurns = 0;

  readonly repos = signal<ChangeRepo[]>([]);
  readonly loaded = signal(false);
  readonly part = signal<Part>('whole');
  private readonly listings = signal<Record<string, DiffListing>>({});
  private readonly bases = signal<Record<string, BaseInfo>>({});
  private readonly expanded = signal<readonly string[]>([]);
  private readonly activeName = signal<string | null>(null);

  /** The file being read; null until one is picked. */
  readonly selected = signal<FileRef | null>(null);
  /** The listed entry of the file being read, kept as it last was when the file leaves the change. */
  readonly selectedFile = signal<ChangedFile | null>(null);
  readonly pair = signal<FilePair | null>(null);
  /** Fresh text for the new side of the open file after a refresh; cleared when another file is opened. */
  readonly modifiedText = signal<string | null>(null);
  /** The open file is no longer part of the change; its last content stays on show. */
  readonly gone = signal(false);
  readonly layout = signal<DiffLayout>('side');
  readonly narrow = signal(false);
  /** The engineer asked to step to the next or previous change; the editor does it. */
  readonly stepRequest = signal<StepRequest | null>(null);
  readonly sideBySide = computed(() => this.layout() === 'side' && !this.narrow());

  readonly partOptions = PART_OPTIONS;
  private readonly prStates = signal<PrState[]>([]);
  /** What the pull request is titled. */
  readonly prTitle = signal('');
  /** The open repository's pull request, or null while it has none. */
  readonly pr = computed(() => {
    const a = this.active();
    const url = a === null ? null : (this.prStates().find((p) => p.repo === a.repo)?.url ?? null);
    return url === null ? null : { url, number: prNumber(url) };
  });
  readonly active = computed(() => this.repos().find((r) => r.repo === this.activeName()) ?? null);
  readonly base = computed(() => {
    const a = this.active();
    return a === null ? null : (this.bases()[a.repo] ?? a.base);
  });
  readonly files = computed<ChangedFile[]>(() => this.listings()[this.activeName() ?? '']?.files ?? NO_FILES);
  readonly loc = computed(() => this.listings()[this.activeName() ?? '']?.loc ?? []);
  readonly groups = computed<RepoFileGroup[]>(() =>
    this.repos().map((r) => ({ repo: r.repo, expanded: this.expanded().includes(r.repo), files: this.listings()[r.repo]?.files ?? NO_FILES })),
  );

  constructor() {
    const query = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(NARROW) : null;
    if (query === null) return;
    this.narrow.set(query.matches);
    const onChange = (e: MediaQueryListEvent) => this.narrow.set(e.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
  }

  /** Start looking at a change: list its repositories and the files of the whole change. A new change starts over. */
  async open(ctx: ChangesContext): Promise<void> {
    const c = this.context;
    if (c !== null && c.folder === ctx.folder && c.masterRepo === ctx.masterRepo && c.system === ctx.system && c.change === ctx.change) return;
    this.context = ctx;
    this.loaded.set(false);
    this.selected.set(null);
    this.selectedFile.set(null);
    this.pair.set(null);
    this.modifiedText.set(null);
    this.gone.set(false);
    this.activeName.set(null);
    this.expanded.set([]);
    await this.reload('open');
  }

  /** The pull requests the page knows of, and what they are titled. */
  setPullRequests(states: PrState[], title: string): void {
    this.prStates.set(states);
    this.prTitle.set(title);
  }

  /** Read the lists, the base and the open file again, without moving the engineer. */
  async refresh(): Promise<void> {
    if (this.context !== null) await this.reload('refresh');
  }

  /** The count of `turn` events across the build's runs; when it grows the agents have worked, so look again. */
  async noteTurns(turns: number): Promise<void> {
    const grew = turns > this.lastTurns;
    this.lastTurns = turns;
    if (grew) await this.refresh();
  }

  async setPart(part: Part): Promise<void> {
    if (part === this.part()) return;
    this.part.set(part);
    if (this.context !== null) await this.reload('part');
  }

  step(direction: StepRequest['direction']): void {
    this.stepRequest.update((s) => ({ direction, serial: (s?.serial ?? 0) + 1 }));
  }

  setLayout(layout: DiffLayout): void {
    this.layout.set(layout);
  }

  /** Open or close a repository's files; opening one also makes it the repository the header describes. */
  async toggle(repo: string): Promise<void> {
    const open = this.expanded().includes(repo);
    this.expanded.update((e) => (open ? e.filter((r) => r !== repo) : [...e, repo]));
    if (!open) await this.activate(repo);
  }

  /** Read one file's two sides and show them. */
  async select(repo: string, path: string): Promise<void> {
    const r = this.repos().find((x) => x.repo === repo);
    const file = this.listings()[repo]?.files.find((f) => f.path === path);
    if (!r || !file) return;
    const pick = ++this.pickSeq;
    try {
      const pair = await this.transport.sdlcDiffPair(r.path, this.part(), path);
      if (pick !== this.pickSeq) return;
      this.modifiedText.set(null);
      this.gone.set(false);
      this.selected.set({ repo, path });
      this.selectedFile.set(file);
      this.pair.set(pair);
      if (!this.expanded().includes(repo)) this.expanded.update((e) => [...e, repo]);
      await this.activate(repo);
    } catch (e) {
      if (pick === this.pickSeq) this.toasts.error(`Could not read ${path}: ${message(e)}`);
    }
  }

  /** Make a repository the one the header describes, reading its base if it is not known yet. */
  private async activate(repo: string): Promise<void> {
    this.activeName.set(repo);
    const r = this.repos().find((x) => x.repo === repo);
    if (r && this.bases()[repo] === undefined) await this.readBase(r);
  }

  private async readBase(r: ChangeRepo): Promise<void> {
    try {
      const base = await this.transport.sdlcDiffBase(r.path);
      this.bases.update((b) => ({ ...b, [r.repo]: base }));
    } catch (e) {
      this.toasts.error(`Could not read the base of ${r.repo}: ${message(e)}`);
    }
  }

  private async reload(kind: Reload): Promise<void> {
    const ctx = this.context;
    if (ctx === null) return;
    const seq = ++this.seq;
    const part = this.part();
    const sel = this.selected();
    try {
      const found = await this.transport.sdlcChangeRepos(ctx.folder, ctx.masterRepo, ctx.system, ctx.change);
      const repos = [...found.filter((r) => r.repo === ctx.masterRepo), ...found.filter((r) => r.repo !== ctx.masterRepo)];
      const lists = await Promise.all(repos.map((r) => this.transport.sdlcDiffFiles(r.path, part)));
      const name = repos.find((r) => r.repo === this.activeName())?.repo ?? repos[0]?.repo ?? null;
      const active = repos.find((r) => r.repo === name);
      const base = active ? await this.transport.sdlcDiffBase(active.path) : null;
      const at = sel ? repos.findIndex((r) => r.repo === sel.repo) : -1;
      const file = sel && at >= 0 ? lists[at].files.find((f) => f.path === sel.path) : undefined;
      const pair = file && sel ? await this.transport.sdlcDiffPair(repos[at].path, part, sel.path) : null;
      if (seq !== this.seq) return;
      this.repos.set(repos);
      this.listings.set(Object.fromEntries(repos.map((r, i) => [r.repo, lists[i]])));
      this.activeName.set(name);
      if (active && base) this.bases.update((b) => ({ ...b, [active.repo]: base }));
      if (kind === 'open' && name !== null) this.expanded.set([name]);
      // A pick made while this was reading has already chosen what is on show; only the lists are new.
      if (sel === this.selected()) this.keepPlace(kind, sel, file, pair);
      this.loaded.set(true);
    } catch (e) {
      if (seq === this.seq) this.toasts.error(`Could not read what changed: ${message(e)}`);
    }
  }

  /** Decide what the editor shows after a reload: the same file's latest text, its new part, or nothing. */
  private keepPlace(kind: Reload, sel: FileRef | null, file: ChangedFile | undefined, pair: FilePair | null): void {
    if (sel === null || kind === 'open') return;
    if (file === undefined || pair === null) {
      if (kind === 'refresh') {
        this.gone.set(true);
        return;
      }
      this.selected.set(null);
      this.selectedFile.set(null);
      this.pair.set(null);
      this.modifiedText.set(null);
      this.gone.set(false);
      return;
    }
    this.gone.set(false);
    this.selectedFile.set(file);
    if (kind === 'part' || this.pair() === null) {
      this.modifiedText.set(null);
      this.pair.set(pair);
    } else {
      this.modifiedText.set(pair.modified);
    }
  }
}

import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { BaseInfo } from '@bindings/BaseInfo';
import type { BuildRow } from '@bindings/BuildRow';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { FileTypeStats } from '@bindings/FileTypeStats';
import type { Part } from '@bindings/Part';
import { ProgressStore } from '../../core/progress/progress.store';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { tieFiles } from '../../lib/file-ties';
import { locateFinding, type RepoPaths } from '../../lib/finding-place';
import { progressLabels } from '../../lib/progress-steps';
import type { DiffLayout } from '../../ui/diff-bar';
import type { FindingMark, StepRequest } from '../../ui/diff-editor/diff-editor';
import type { FileRef, RepoFile, RepoFileGroup } from '../../ui/repo-file-list';

/** What the Changes view looks at: the workspace folder, its master repository, and the system's change. */
export type ChangesContext = { folder: string; masterRepo: string; system: string; change: string };

export const PART_OPTIONS: { value: Part; label: string }[] = [
  { value: 'whole', label: 'Whole change' },
  { value: 'committed', label: 'Committed' },
  { value: 'uncommitted', label: 'Uncommitted' },
];

/** A finding the engineer picked, as the host passes it: `n` makes a repeated pick of the same finding a new request. */
export type ShowAt = { file: string; line: number | null; text: string; n: number; repo?: string };

/** Below this width the list stacks above the diff and the editor is always inline (Tailwind's `md` breakpoint). */
const NARROW = '(max-width: 767.98px)';
const NOT_IN_CHANGE = "This finding's file is not part of this change.";
const NOT_IN_PART = "Showing the whole change: this finding's file is not in the part you were looking at.";
const NO_FILES: ChangedFile[] = [];
const NO_COMMITS: CommitFiles[] = [];
/** The progress entry of this view: the Changes view is the only place on its page that reads what changed. */
const PROGRESS_OWNER = 'changes';
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
  private readonly progress = inject(ProgressStore);
  /** What reading the change's repositories reports while it runs long enough to show. */
  readonly readProgress = this.progress.view(PROGRESS_OWNER);

  private context: ChangesContext | null = null;
  /** Newer reloads supersede older ones still reading; picks have their own count so a pick never cancels a reload. */
  private seq = 0;
  private pickSeq = 0;
  private lastTurns = 0;
  /** A newer finding pick supersedes an older one still reading; a pick made before the repositories are read waits here. */
  private findingSeq = 0;
  private pendingFinding: ShowAt | null = null;
  private findingLists: RepoPaths[] = [];

  readonly repos = signal<ChangeRepo[]>([]);
  /** Product repositories in the build with no change branch, which the list cannot show; empty when that could not be read. */
  readonly missingBranches = signal<string[]>([]);
  readonly loaded = signal(false);
  readonly part = signal<Part>('whole');
  private readonly listings = signal<Record<string, DiffListing>>({});
  private readonly bases = signal<Record<string, BaseInfo>>({});
  /** The commits of each repository and the files each touched; a repository whose commits could not be read has none, so its files stay untied. */
  private readonly commits = signal<Record<string, CommitFiles[]>>({});
  /** The part the current listings were read for, which the ties are computed for. */
  private readonly listedPart = signal<Part>('whole');
  private readonly rows = signal<BuildRow[]>([]);
  private readonly stopped = signal<readonly string[]>([]);
  private readonly picked = signal<{ id: string; repo: string } | null>(null);
  private readonly untiedShown = signal(false);
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
  /** One line saying why a picked finding did not simply open, or null. */
  readonly findingNote = signal<string | null>(null);
  /** The repositories that all have the picked finding's file, for the engineer to choose from; null when there is no choice to make. */
  readonly findingChoice = signal<{ repos: string[]; path: string; line: number | null; text: string } | null>(null);
  /** The picked finding's place in the open file, which the editor marks. */
  readonly mark = signal<FindingMark | null>(null);
  readonly sideBySide = computed(() => this.layout() === 'side' && !this.narrow());

  readonly partOptions = PART_OPTIONS;
  readonly active = computed(() => this.repos().find((r) => r.repo === this.activeName()) ?? null);
  readonly base = computed(() => {
    const a = this.active();
    return a === null ? null : (this.bases()[a.repo] ?? a.base);
  });
  /** The files of the open part in every listed repository, in the order the list shows them. */
  private readonly listed = computed<ChangedFile[]>(() => this.repos().flatMap((r) => this.listings()[r.repo]?.files ?? NO_FILES));
  readonly fileCount = computed(() => this.listed().length);
  readonly fileCountLabel = computed(() => `${this.fileCount()} ${this.fileCount() === 1 ? 'file' : 'files'}`);
  /** Lines added and removed by the open part across every listed repository; a binary file counts none. */
  readonly totals = computed(() => {
    const text = this.listed().filter((f) => !f.binary);
    return { added: text.reduce((n, f) => n + f.added, 0), removed: text.reduce((n, f) => n + f.removed, 0) };
  });
  /** The lines by file type across every listed repository, the type with the most changed lines first. */
  readonly loc = computed<FileTypeStats[]>(() => {
    const byType = new Map<string, FileTypeStats>();
    for (const r of this.repos()) {
      for (const t of this.listings()[r.repo]?.loc ?? []) {
        const sum = byType.get(t.extension);
        byType.set(t.extension, sum ? { ...sum, files: sum.files + t.files, added: sum.added + t.added, removed: sum.removed + t.removed } : { ...t });
      }
    }
    return [...byType.values()].sort((x, y) => y.added + y.removed - (x.added + x.removed) || x.extension.localeCompare(y.extension));
  });
  /** What the strip says about the open repository: that it is read only and, once known, what it is compared with. */
  readonly readOnlyNote = computed(() => {
    const base = this.base();
    return base === null ? 'read-only' : `read-only · compared at the merge base with ${base.reference}`;
  });
  /** Each repository's files with the tasks they are tied to; with a task picked, only its repository, opened, with its tied files and the ones not tied counted. */
  readonly groups = computed<RepoFileGroup[]>(() => {
    const picked = this.picked();
    const shown = this.untiedShown();
    const stopped = this.stopped();
    const rows = this.rows();
    const repos = picked === null ? this.repos() : this.repos().filter((r) => r.repo === picked.repo);
    return repos.map((r) => {
      const files = this.listings()[r.repo]?.files ?? NO_FILES;
      const ties = tieFiles(rows, r.repo, this.commits()[r.repo] ?? NO_COMMITS, files, this.listedPart());
      const all: RepoFile[] = files.map((f) => ({ ...f, tasks: ties.get(f.path) ?? [], left: f.uncommitted && stopped.includes(r.repo) }));
      return {
        repo: r.repo,
        branch: r.branch,
        base: (this.bases()[r.repo] ?? r.base).base,
        expanded: picked !== null || this.expanded().includes(r.repo),
        files: picked === null ? all : all.filter((f) => f.tasks.includes(picked.id)),
        untied: picked === null ? null : all.filter((f) => f.tasks.length === 0),
        untiedShown: shown,
      };
    });
  });

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

  /** The build log's rows, which say which task made which commit. */
  setRows(rows: BuildRow[]): void {
    this.rows.set(rows);
  }

  /** The repositories whose run stopped. */
  setStopped(stopped: string[]): void {
    this.stopped.set(stopped);
  }

  /** The task the engineer picked, or null. Any pick starts the untied files hidden again. */
  setTask(task: { id: string; repo: string } | null): void {
    this.picked.set(task);
    this.untiedShown.set(false);
  }

  /** List the files not tied to the picked task under its repository. */
  showUntied(): void {
    this.untiedShown.set(true);
  }

  /**
   * Show a picked finding's file at its line, or say why it cannot be shown. A pick made before the repositories are
   * read waits for them. A finding that names no file changes nothing here; the findings area says it.
   */
  async showAt(request: ShowAt): Promise<void> {
    const run = ++this.findingSeq;
    this.findingNote.set(null);
    this.findingChoice.set(null);
    this.mark.set(null);
    if (!this.loaded()) {
      this.pendingFinding = request;
      return;
    }
    this.pendingFinding = null;
    let lists: RepoPaths[];
    try {
      lists = await Promise.all(this.repos().map((r) => this.readPaths(r)));
    } catch (e) {
      if (run === this.findingSeq) this.toasts.error(`Could not read what changed: ${message(e)}`);
      return;
    }
    if (run !== this.findingSeq) return;
    this.findingLists = lists;
    const outcome = locateFinding({ file: request.file, line: request.line ?? undefined, repo: request.repo }, lists, this.part());
    switch (outcome.kind) {
      case 'no-file':
        return;
      case 'not-in-change':
        this.findingNote.set(NOT_IN_CHANGE);
        return;
      case 'choose':
        this.findingChoice.set({ repos: outcome.repos, path: outcome.path, line: outcome.line, text: request.text });
        return;
      case 'show':
        await this.present(run, outcome.repo, outcome.path, outcome.line, request.text, outcome.switchToWhole);
    }
  }

  /** Continue a picked finding in the repository the engineer chose from the list. */
  async chooseRepo(repo: string): Promise<void> {
    const choice = this.findingChoice();
    if (choice === null) return;
    const run = ++this.findingSeq;
    this.findingChoice.set(null);
    const listed = this.findingLists.find((r) => r.repo === repo);
    const switchToWhole = listed !== undefined && !listed[this.part()].includes(choice.path);
    await this.present(run, repo, choice.path, choice.line, choice.text, switchToWhole);
  }

  /** Every file of each part of one repository's change. */
  private async readPaths(r: ChangeRepo): Promise<RepoPaths> {
    const [whole, committed, uncommitted] = await Promise.all(
      (['whole', 'committed', 'uncommitted'] as const).map(async (p) => (await this.transport.sdlcDiffFiles(r.path, p)).files.map((f) => f.path)),
    );
    return { repo: r.repo, whole, committed, uncommitted };
  }

  /** Open a finding's file, in the whole change when the part on show lacks it, and mark the line once the file is on show. */
  private async present(run: number, repo: string, path: string, line: number | null, text: string, switchToWhole: boolean): Promise<void> {
    if (switchToWhole) {
      await this.setPart('whole');
      if (run !== this.findingSeq) return;
      this.findingNote.set(NOT_IN_PART);
    }
    await this.select(repo, path);
    const at = this.selected();
    if (run === this.findingSeq && at?.repo === repo && at.path === path) this.mark.set({ line, text });
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
    this.mark.set(null);
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
    this.progress.begin('reading-diff', progressLabels.findingRepos(), PROGRESS_OWNER);
    try {
      // A failure here only loses the note; the repositories with changes still list.
      const missing = this.transport.sdlcMissingChangeBranches(ctx.folder, ctx.masterRepo, ctx.system, ctx.change).catch(() => []);
      const found = await this.transport.sdlcChangeRepos(ctx.folder, ctx.masterRepo, ctx.system, ctx.change);
      const repos = [...found.filter((r) => r.repo === ctx.masterRepo), ...found.filter((r) => r.repo !== ctx.masterRepo)];
      // A commit read that fails leaves that repository's files untied; it never fails the list.
      // The plain label names the first repository still being read and moves on as each one is read.
      const waiting = new Set(repos.map((r) => r.repo));
      const readOne = (repo: string): void => {
        waiting.delete(repo);
        const next = waiting.values().next();
        if (!next.done && seq === this.seq) this.progress.update(progressLabels.readingDiff(next.value), PROGRESS_OWNER);
      };
      if (repos.length > 0) this.progress.update(progressLabels.readingDiff(repos[0].repo), PROGRESS_OWNER);
      const [lists, commitLists] = await Promise.all([
        Promise.all(repos.map((r) => this.transport.sdlcDiffFiles(r.path, part).finally(() => readOne(r.repo)))),
        Promise.all(repos.map((r) => this.transport.sdlcCommitFiles(r.path).catch((): CommitFiles[] => NO_COMMITS))),
      ]);
      const name = repos.find((r) => r.repo === this.activeName())?.repo ?? repos[0]?.repo ?? null;
      const active = repos.find((r) => r.repo === name);
      const base = active ? await this.transport.sdlcDiffBase(active.path) : null;
      const at = sel ? repos.findIndex((r) => r.repo === sel.repo) : -1;
      const file = sel && at >= 0 ? lists[at].files.find((f) => f.path === sel.path) : undefined;
      const pair = file && sel ? await this.transport.sdlcDiffPair(repos[at].path, part, sel.path) : null;
      const noBranch = await missing;
      if (seq !== this.seq) return;
      this.progress.end(PROGRESS_OWNER);
      this.repos.set(repos);
      this.missingBranches.set(noBranch);
      this.listings.set(Object.fromEntries(repos.map((r, i) => [r.repo, lists[i]])));
      this.commits.set(Object.fromEntries(repos.map((r, i) => [r.repo, commitLists[i]])));
      this.listedPart.set(part);
      this.activeName.set(name);
      if (active && base) this.bases.update((b) => ({ ...b, [active.repo]: base }));
      if (kind === 'open' && name !== null) this.expanded.set([name]);
      // A pick made while this was reading has already chosen what is on show; only the lists are new.
      if (sel === this.selected()) this.keepPlace(kind, sel, file, pair);
      this.loaded.set(true);
      const pending = this.pendingFinding;
      if (pending !== null) void this.showAt(pending);
    } catch (e) {
      if (seq === this.seq) {
        this.progress.fail(PROGRESS_OWNER);
        this.toasts.error(`Could not read what changed: ${message(e)}`);
      }
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

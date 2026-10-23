import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { ChangedFile } from '@bindings/ChangedFile';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { branchLabel, splitPath } from '../lib/file-path';
import { FILE_STATUS } from './file-status';

/** A changed file with the tasks it is tied to (none when not tied) and whether the stopped run of its repository left it uncommitted. */
export type RepoFile = ChangedFile & { tasks: string[]; left: boolean };
/** One repository in the list: its name, its change branch and the base it is compared with (null until known), whether its files are shown, and the files of the part being looked at.
 * `untied` is null unless the list is narrowed to a task; then it holds the repository's files not tied to any task, listed only once `untiedShown`. */
export type RepoFileGroup = { repo: string; branch: string; base: string | null; expanded: boolean; files: RepoFile[]; untied: RepoFile[] | null; untiedShown: boolean };
export type FileRef = { repo: string; path: string };

/* The Changes view's left column: the repositories with changes, master first, each expandable to its files.
 * A repository header carries its branch against its base. A file row carries its status letter with a name, the file name over its
 * folder (each cut with an ellipsis, the folder from its start), a dot when it has edits that are not committed, and its line counts. */
@Component({
  selector: 'app-repo-file-list',
  imports: [NgIcon, NgTemplateOutlet, HlmButtonImports],
  providers: [provideIcons({ lucideChevronDown, lucideChevronRight })],
  templateUrl: './repo-file-list.html',
})
export class RepoFileList {
  readonly groups = input.required<RepoFileGroup[]>();
  readonly selected = input<FileRef | null>(null);
  readonly toggle = output<string>();
  readonly select = output<FileRef>();
  /** The engineer asked to list the files not tied to a task in this repository. */
  readonly showUntied = output<string>();

  protected readonly statusOf = (s: ChangedFile['status']) => FILE_STATUS[s];
  protected readonly branchLabel = branchLabel;
  protected readonly splitPath = splitPath;

  protected isSelected(repo: string, path: string): boolean {
    const s = this.selected();
    return s !== null && s.repo === repo && s.path === path;
  }
}

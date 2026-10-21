import { Component, input, output } from '@angular/core';
import type { ChangedFile } from '@bindings/ChangedFile';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { branchLabel, splitPath } from '../lib/file-path';
import { FILE_STATUS } from './file-status';

/** One repository in the list: its name, its change branch and the base it is compared with (null until known), whether its files are shown, and the files of the part being looked at. */
export type RepoFileGroup = { repo: string; branch: string; base: string | null; expanded: boolean; files: ChangedFile[] };
export type FileRef = { repo: string; path: string };

/* The Changes view's left column: the repositories with changes, master first, each expandable to its files.
 * A repository header carries its branch against its base. A file row carries its status letter with a name, the file name over its
 * folder (each cut with an ellipsis, the folder from its start), a dot when it has edits that are not committed, and its line counts. */
@Component({
  selector: 'app-repo-file-list',
  imports: [NgIcon, HlmButtonImports],
  providers: [provideIcons({ lucideChevronDown, lucideChevronRight })],
  templateUrl: './repo-file-list.html',
})
export class RepoFileList {
  readonly groups = input.required<RepoFileGroup[]>();
  readonly selected = input<FileRef | null>(null);
  readonly toggle = output<string>();
  readonly select = output<FileRef>();

  protected readonly status = FILE_STATUS;
  protected readonly branchLabel = branchLabel;
  protected readonly splitPath = splitPath;

  protected isSelected(repo: string, path: string): boolean {
    const s = this.selected();
    return s !== null && s.repo === repo && s.path === path;
  }
}

import { Component, effect, inject, input, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { DiffBar } from '../../ui/diff-bar';
import { DiffEditor } from '../../ui/diff-editor/diff-editor';
import { RepoFileList } from '../../ui/repo-file-list';
import { Segmented } from '../../ui/segmented';
import { ChangesViewModel } from './changes-view.view-model';

/* What changed in a change, read only: the repositories with changes on the left, and on the right which base they
 * are compared with, the part of the change on show, and the diff of the open file. `turns` counts the build's
 * turns; when it grows the view reads again and keeps the engineer's place. */
@Component({
  selector: 'app-changes-view',
  host: { class: 'block h-full min-h-0' },
  providers: [ChangesViewModel, provideIcons({ lucideTriangleAlert })],
  imports: [NgIcon, HlmAlertImports, RepoFileList, Segmented, DiffBar, DiffEditor],
  templateUrl: './changes-view.html',
  styleUrl: './changes-view.css',
})
export class ChangesView {
  protected readonly vm = inject(ChangesViewModel);

  readonly folder = input.required<string>();
  readonly masterRepo = input.required<string>();
  readonly system = input.required<string>();
  readonly change = input.required<string>();
  readonly turns = input(0);
  readonly banner = input<string | null>(null);

  constructor() {
    effect(() => {
      const ctx = { folder: this.folder(), masterRepo: this.masterRepo(), system: this.system(), change: this.change() };
      untracked(() => void this.vm.open(ctx));
    });
    effect(() => {
      const turns = this.turns();
      untracked(() => void this.vm.noteTurns(turns));
    });
  }
}

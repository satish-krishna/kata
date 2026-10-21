import { Component, effect, inject, input, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { DiffBar } from '../../ui/diff-bar';
import { DiffEditor } from '../../ui/diff-editor/diff-editor';
import { RepoFileList } from '../../ui/repo-file-list';
import { Segmented } from '../../ui/segmented';
import { ChangesViewModel } from './changes-view.view-model';

/* What changed in a change, read only: a strip across the top (the part of the change on show, its totals, the lines by type and
 * which base it is compared with, and whatever the host projects at its right end), the repositories with changes on the left, and the diff of the open file on the right.
 * `turns` counts the build's turns; when it grows the view reads again and keeps the engineer's place. */
@Component({
  selector: 'app-changes-view',
  host: { class: 'block h-full min-h-0' },
  providers: [ChangesViewModel, provideIcons({ lucideChevronDown, lucideTriangleAlert })],
  imports: [NgIcon, HlmAlertImports, HlmButtonImports, HlmPopoverImports, RepoFileList, Segmented, DiffBar, DiffEditor],
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
  /** True when the host projects content into the strip's right end (the change page's facts and actions); the strip then draws even before any repository has changes. */
  readonly hasSlot = input(false);

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

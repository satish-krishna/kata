import { Component, effect, inject, input, output, untracked } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { FindingsList } from '../../ui/findings-list';
import { ObservePane } from '../../ui/observe-pane';
import { RepoStatusList } from '../../ui/repo-status-list';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

/* The build, in the page's main region: a row per repository on the left, and on the right the runs of the one picked,
 * each in its own observe pane. It takes the lock when it opens and gives it back when the engineer closes it. */
@Component({
  selector: 'app-build-view',
  host: { class: 'contents' },
  providers: [BuildViewModel],
  imports: [HlmButtonImports, ObservePane, RepoStatusList, FindingsList],
  templateUrl: './build-view.html',
  styleUrl: './build-view.css',
})
export class BuildView {
  protected readonly vm = inject(BuildViewModel);

  readonly handoff = input.required<BuildHandoff>();
  readonly context = input.required<BuildContext>();
  /** The lock is released, or the build could not take it: the page goes back to the change. */
  readonly closed = output<void>();

  constructor() {
    // The build starts once, from the first handoff; the view model ignores a later change of the same inputs.
    effect(() => {
      const handoff = this.handoff();
      const context = this.context();
      untracked(() =>
        void this.vm.start(handoff, context).then((started) => {
          if (!started) this.closed.emit();
        }),
      );
    });
  }

  protected async close(): Promise<void> {
    if (await this.vm.close()) this.closed.emit();
  }
}

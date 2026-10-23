import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, Injector, afterNextRender, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight, lucidePanelLeftClose, lucidePanelLeftOpen, lucidePanelTopClose, lucidePanelTopOpen } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmResizableImports } from '@spartan-ng/helm/resizable';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { BuildRefusalDialog } from '../../ui/build-refusal-dialog';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FindingsList } from '../../ui/findings-list';
import { ObservePane } from '../../ui/observe-pane';
import { RunPreviewDialog } from '../../ui/run-preview-dialog';
import { RepoStatusList } from '../../ui/repo-status-list';
import { WaitingNotice } from '../../ui/waiting-notice';
import type { BuildHandoff } from '../change/change-page.view-model';
import { ChangesView } from '../changes/changes-view';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

/* The build, in the page's main region: a row per repository on the left, and on the right two views of the same build,
 * Activity (the runs of the repository picked, each in its own observe pane) and Changes (what the agents changed so far).
 * Both stay mounted for the whole build; the one not shown is hidden, so nothing is read again or lost by switching.
 * It takes the lock when it opens and gives it back when the engineer closes it. */
@Component({
  selector: 'app-build-view',
  host: { class: 'contents' },
  providers: [BuildViewModel, RunPreviewViewModel, provideIcons({ lucideChevronDown, lucideChevronRight, lucidePanelLeftClose, lucidePanelLeftOpen, lucidePanelTopClose, lucidePanelTopOpen })],
  imports: [HlmButtonImports, HlmResizableImports, NgIcon, NgTemplateOutlet, BuildRefusalDialog, ConfirmDialog, HlmTabsImports, ObservePane, RunPreviewDialog, RepoStatusList, FindingsList, WaitingNotice, ChangesView],
  templateUrl: './build-view.html',
  styleUrl: './build-view.css',
})
export class BuildView {
  protected readonly vm = inject(BuildViewModel);
  /** The Changes view, whose file list the drawer shows while Changes is on show. */
  protected readonly changesView = viewChild(ChangesView);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

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
    // "Go to <repo>" is asked of the view model; the DOM half (scroll and focus) waits until the panel is shown.
    effect(() => {
      const request = this.vm.focusRequest();
      if (request === null) return;
      untracked(() => afterNextRender(() => this.focusOpenCard(request.repo), { injector: this.injector }));
    });
  }

  /** Bring the repository's open question or approval into view and put the focus on its first control. */
  private focusOpenCard(repo: string): void {
    const group = this.host.nativeElement.querySelector(`[data-repo-runs="${repo}"]`);
    const card = group?.querySelector<HTMLElement>('.k-ask:not(.k-ask--answered):not(.k-ask--lapsed)');
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.querySelector<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]')?.focus();
  }

  protected async close(): Promise<void> {
    if (await this.vm.close()) this.closed.emit();
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, Injector, type Provider, type Type, afterNextRender, effect, inject, output, untracked, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight, lucidePanelLeftClose, lucidePanelLeftOpen, lucidePanelTopClose, lucidePanelTopOpen } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmResizableImports } from '@spartan-ng/helm/resizable';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { BuildRefusalDialog } from '../../ui/build-refusal-dialog';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { FindingsList } from '../../ui/findings-list';
import { ObservePane } from '../../ui/observe-pane';
import { RepoStatusList } from '../../ui/repo-status-list';
import { WaitingNotice } from '../../ui/waiting-notice';
import { ChangesView } from '../changes/changes-view';
import { BuildPageViewModel } from './build-page.view-model';

/** The instance of a view model the change page provides, so the view shows the build the page owns instead of making its own. */
const fromChangePage = <T>(token: Type<T>): Provider[] => [{ provide: token, useFactory: () => inject(token, { skipSelf: true }) }];

/* The build, in the page's main region: a row per repository on the left, and on the right two views of the same build,
 * Activity (the runs of the repository picked, each in its own observe pane) and Changes (what the agents changed so far).
 * Both stay mounted for the whole build; the one not shown is hidden, so nothing is read again or lost by switching.
 * The build and its driver belong to the change page: this view only shows them, and leaving it touches neither the lock nor the driver. */
@Component({
  selector: 'app-build-view',
  host: { class: 'contents' },
  providers: [
    ...fromChangePage(BuildPageViewModel),
    provideIcons({ lucideChevronDown, lucideChevronRight, lucidePanelLeftClose, lucidePanelLeftOpen, lucidePanelTopClose, lucidePanelTopOpen }),
  ],
  imports: [HlmButtonImports, HlmResizableImports, NgIcon, NgTemplateOutlet, BuildRefusalDialog, ConfirmDialog, HlmTabsImports, ObservePane, RepoStatusList, FindingsList, WaitingNotice, ChangesView],
  templateUrl: './build-view.html',
  styleUrl: './build-view.css',
})
export class BuildView {
  protected readonly vm = inject(BuildPageViewModel);
  /** The Changes view, whose file list the drawer shows while Changes is on show. */
  protected readonly changesView = viewChild(ChangesView);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The engineer went back to the change: the page reads it again. */
  readonly closed = output<void>();

  constructor() {
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

  protected back(): void {
    this.closed.emit();
  }
}

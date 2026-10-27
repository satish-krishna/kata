import { NgTemplateOutlet } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { BuildLayoutViewModel } from '../build/build-layout.view-model';
import { BuildPageViewModel } from '../build/build-page.view-model';
import { BuildPage } from '../build/build-page';
import { BuildDialog } from '../../ui/build-dialog';
import { BuildRefusalDialog } from '../../ui/build-refusal-dialog';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { NewChangeDialog } from '../../ui/new-change-dialog';
import { DocLayout } from '../../ui/doc-layout';
import { DoneDialog } from '../../ui/done-dialog';
import { FeedbackDialog } from '../../ui/feedback-dialog';
import { LeftoverDialog } from '../../ui/leftover-dialog';
import { LockOverlay } from '../../ui/lock-overlay';
import { PrListDialog } from '../../ui/pr-list-dialog';
import { RequirementsView } from '../../ui/requirements-view';
import { Segmented } from '../../ui/segmented';
import { SdlcSession } from '../../ui/sdlc-session';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { StagePills } from '../../ui/stage-pills';
import { TasksView } from '../../ui/tasks-view';
import { RunPreviewDialog } from '../../ui/run-preview-dialog';
import { ProgressLine } from '../../ui/progress-line';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { ChangePageViewModel } from './change-page.view-model';

@Component({
  selector: 'app-change-page',
  providers: [ChangePageViewModel, BuildPageViewModel, BuildLayoutViewModel,RunPreviewViewModel, provideIcons({ lucideChevronDown, lucideTriangleAlert })],
  imports: [NgTemplateOutlet, NgIcon, HlmAlertImports, HlmButtonImports, HlmPopoverImports, HlmTabsImports, SdlcToolbar, StagePills, DocLayout, RequirementsView, TasksView, Segmented, LockOverlay, LeftoverDialog, ConfirmDialog, NewChangeDialog, FeedbackDialog, BuildDialog, BuildRefusalDialog, DoneDialog, PrListDialog, SdlcSession, BuildPage, RunPreviewDialog, ProgressLine],
  templateUrl: './change-page.html',
})
export class ChangePage {
  protected readonly vm = inject(ChangePageViewModel);
  protected readonly build = inject(BuildPageViewModel);
  protected readonly layout = inject(BuildLayoutViewModel);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    void this.vm.startDemo(this.route.snapshot.queryParamMap.get('demo'));
  }
}

import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleCheck, lucideFolder, lucideHash, lucideTerminal, lucideTriangleAlert } from '@ng-icons/lucide';
import { Toolbar } from '../ui/toolbar';
import { RunningChanges } from '../sdlc/running-changes';
import { ValidationBanner } from '../ui/validation-banner';
import { ComposePane } from '../ui/compose-pane';
import { ObservePane } from '../ui/observe-pane';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { RunPreviewDialog } from '../ui/run-preview-dialog';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { VersionLine } from '../ui/version-line';
import { WorkbenchViewModel } from './workbench.view-model';

@Component({
  selector: 'app-workbench',
  providers: [
    WorkbenchViewModel,
    RunPreviewViewModel,
    provideIcons({ lucideCircleCheck, lucideFolder, lucideHash, lucideTerminal, lucideTriangleAlert }),
  ],
  imports: [NgIcon, Toolbar, RunningChanges, ValidationBanner, ComposePane, ObservePane, ConfirmDialog, RunPreviewDialog, VersionLine],
  templateUrl: './workbench.html',
  host: { '(document:keydown)': 'vm.onKey($event)' },
})
export class Workbench {
  protected readonly vm = inject(WorkbenchViewModel);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    void this.vm.init(this.route.snapshot.queryParamMap.get('demo') === 'run');
  }
}

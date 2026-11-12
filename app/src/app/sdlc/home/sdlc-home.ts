import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderPlus, lucidePlus, lucideSquare } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AddWorkspaceDialog } from '../../ui/add-workspace-dialog';
import { ChangesTable } from '../../ui/changes-table';
import { FinishedChanges } from '../../ui/finished-changes';
import { Segmented } from '../../ui/segmented';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { LeftoverDialog } from '../../ui/leftover-dialog';
import { LockOverlay } from '../../ui/lock-overlay';
import { SdlcSession } from '../../ui/sdlc-session';
import { NewChangeDialog } from '../../ui/new-change-dialog';
import { InstructionsRow } from '../../ui/instructions-row';
import { ReposTable } from '../../ui/repos-table';
import { SdlcSettingsDialog } from '../../ui/sdlc-settings-dialog';
import { ProgressLine } from '../../ui/progress-line';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { RunningChanges } from '../running-changes';
import { RunPreviewDialog } from '../../ui/run-preview-dialog';
import { RunPreviewViewModel } from '../../core/given/run-preview.view-model';
import { SdlcHomeViewModel } from './sdlc-home.view-model';

@Component({
  selector: 'app-sdlc-home',
  providers: [SdlcHomeViewModel, RunPreviewViewModel, provideIcons({ lucideFolderPlus, lucidePlus, lucideSquare })],
  imports: [
    NgIcon,
    HlmButtonImports,
    SdlcToolbar,
    RunningChanges,
    SdlcSession,
    ChangesTable,
    FinishedChanges,
    Segmented,
    ProgressLine,
    InstructionsRow,
    ReposTable,
    AddWorkspaceDialog,
    NewChangeDialog,
    SdlcSettingsDialog,
    LeftoverDialog,
    LockOverlay,
    ConfirmDialog,
    RunPreviewDialog,
  ],
  templateUrl: './sdlc-home.html',
  host: { '(window:focus)': 'vm.windowFocused()' },
})
export class SdlcHome {
  protected readonly vm = inject(SdlcHomeViewModel);

  private readonly route = inject(ActivatedRoute);

  constructor() {
    const query = this.route.snapshot.queryParamMap;
    void this.vm.init(query.get('demo'), query.get('context'));
  }
}

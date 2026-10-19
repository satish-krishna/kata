import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderPlus, lucidePlus } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AddWorkspaceDialog } from '../../ui/add-workspace-dialog';
import { ChangesTable } from '../../ui/changes-table';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { LeftoverDialog } from '../../ui/leftover-dialog';
import { LockOverlay } from '../../ui/lock-overlay';
import { NewChangeDialog } from '../../ui/new-change-dialog';
import { ReposTable } from '../../ui/repos-table';
import { SdlcSettingsDialog } from '../../ui/sdlc-settings-dialog';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { SdlcHomeViewModel } from './sdlc-home.view-model';

@Component({
  selector: 'app-sdlc-home',
  providers: [SdlcHomeViewModel, provideIcons({ lucideFolderPlus, lucidePlus })],
  imports: [
    NgIcon,
    HlmButtonImports,
    SdlcToolbar,
    ChangesTable,
    ReposTable,
    AddWorkspaceDialog,
    NewChangeDialog,
    SdlcSettingsDialog,
    LeftoverDialog,
    LockOverlay,
    ConfirmDialog,
  ],
  templateUrl: './sdlc-home.html',
})
export class SdlcHome {
  protected readonly vm = inject(SdlcHomeViewModel);

  constructor() {
    void this.vm.init();
  }
}

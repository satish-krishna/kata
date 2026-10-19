import { Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { DocView } from '../../ui/doc-view';
import { LeftoverDialog } from '../../ui/leftover-dialog';
import { LockOverlay } from '../../ui/lock-overlay';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { StageStepper } from '../../ui/stage-stepper';
import { ChangePageViewModel } from './change-page.view-model';

@Component({
  selector: 'app-change-page',
  providers: [ChangePageViewModel],
  imports: [HlmButtonImports, SdlcToolbar, StageStepper, DocView, LockOverlay, LeftoverDialog, ConfirmDialog],
  templateUrl: './change-page.html',
})
export class ChangePage {
  protected readonly vm = inject(ChangePageViewModel);
}

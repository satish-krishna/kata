import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { DocView } from '../../ui/doc-view';
import { LeftoverDialog } from '../../ui/leftover-dialog';
import { LockOverlay } from '../../ui/lock-overlay';
import { SdlcSession } from '../../ui/sdlc-session';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { StageStepper } from '../../ui/stage-stepper';
import { ChangePageViewModel } from './change-page.view-model';

@Component({
  selector: 'app-change-page',
  providers: [ChangePageViewModel],
  imports: [HlmButtonImports, HlmTabsImports, SdlcToolbar, StageStepper, DocView, LockOverlay, LeftoverDialog, ConfirmDialog, SdlcSession],
  templateUrl: './change-page.html',
})
export class ChangePage {
  protected readonly vm = inject(ChangePageViewModel);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    void this.vm.startDemo(this.route.snapshot.queryParamMap.get('demo'));
  }
}

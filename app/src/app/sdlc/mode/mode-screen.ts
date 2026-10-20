import { Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ModeScreenViewModel } from './mode-screen.view-model';

@Component({
  selector: 'app-mode-screen',
  providers: [ModeScreenViewModel],
  imports: [HlmButtonImports, HlmCheckbox, HlmLabel],
  templateUrl: './mode-screen.html',
})
export class ModeScreen {
  protected readonly vm = inject(ModeScreenViewModel);
}

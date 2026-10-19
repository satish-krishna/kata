import { Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmLabel } from '@spartan-ng/helm/label';
import { ModeScreenViewModel } from './mode-screen.view-model';

@Component({
  selector: 'app-mode-screen',
  providers: [ModeScreenViewModel],
  imports: [HlmButtonImports, HlmCheckbox, HlmLabel],
  template: `
    <main class="k-mode">
      <section class="k-mode__panel" aria-labelledby="mode-heading">
        <span class="kata-eyebrow">kata</span>
        <h1 id="mode-heading" class="k-mode__heading">How are you working today?</h1>
        <div class="k-mode__cards" role="radiogroup" aria-labelledby="mode-heading">
          <button
            hlmBtn
            variant="bare"
            size="bare"
            type="button"
            role="radio"
            class="k-modecard"
            [class.k-modecard--selected]="vm.selected() === 'workbench'"
            [attr.aria-checked]="vm.selected() === 'workbench'"
            (click)="vm.select('workbench')"
          >
            <span class="k-modecard__eyebrow">workbench</span>
            <span class="k-modecard__title">Compose a run</span>
            <span class="k-modecard__body">Write one run-spec, launch it, watch it.</span>
          </button>
          <button
            hlmBtn
            variant="bare"
            size="bare"
            type="button"
            role="radio"
            class="k-modecard"
            [class.k-modecard--selected]="vm.selected() === 'sdlc'"
            [attr.aria-checked]="vm.selected() === 'sdlc'"
            (click)="vm.select('sdlc')"
          >
            <span class="k-modecard__eyebrow">ai-sdlc</span>
            <span class="k-modecard__title">Work a change</span>
            <span class="k-modecard__body">Take a change through intent → spec → plan in a workspace of repos, across as many sessions as it needs.</span>
          </button>
        </div>
        <div class="k-mode__foot">
          <label hlmLabel class="k-mode__remember">
            <hlm-checkbox [checked]="vm.remember()" (checkedChange)="vm.setRemember($event)" />
            <span>Remember this · switch any time from the toolbar</span>
          </label>
          <button hlmBtn variant="primary" type="button" (click)="vm.open()">Open</button>
        </div>
      </section>
    </main>
  `,
})
export class ModeScreen {
  protected readonly vm = inject(ModeScreenViewModel);
}

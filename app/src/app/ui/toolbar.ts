import { Component, input, model, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFilePlus,
  lucideFolderOpen,
  lucideLibrary,
  lucidePackage,
  lucidePlay,
  lucideSave,
  lucideSquare,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-toolbar',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, HlmInput, RouterLink],
  providers: [
    provideIcons({
      lucideFilePlus,
      lucideFolderOpen,
      lucideLibrary,
      lucidePackage,
      lucidePlay,
      lucideSave,
      lucideSquare,
    }),
  ],
  templateUrl: './toolbar.html',
})
export class Toolbar {
  readonly name = model.required<string>();
  readonly dirty = input.required<boolean>();
  readonly running = input(false);
  readonly canRun = input(true);
  readonly modeSwitchDisabled = input(false);
  readonly switchMode = output<void>();
  readonly newSpec = output<void>();
  readonly openSpec = output<void>();
  readonly save = output<void>();
  readonly exportBundle = output<void>();
  readonly run = output<void>();
  readonly cancel = output<void>();

  protected onName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }
}

import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmToasterImports } from '@spartan-ng/helm/sonner';
import { CloseDialog } from './ui/close-dialog';
import { VersionLine } from './ui/version-line';
import { AppViewModel } from './app.view-model';

@Component({
  selector: 'app-root',
  providers: [AppViewModel],
  imports: [RouterOutlet, HlmToasterImports, CloseDialog, VersionLine],
  templateUrl: './app.html',
  host: { '(document:keydown)': 'vm.onKeydown($event)', '(window:focus)': 'vm.windowFocused()' },
})
export class App {
  protected readonly vm = inject(AppViewModel);
}

import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppShellViewModel } from './app-shell.view-model';
import { Toaster } from './ui/toaster';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Toaster],
  providers: [AppShellViewModel],
  template: `<router-outlet /><app-toaster [toasts]="vm.toasts()" (dismiss)="vm.dismiss($event)" />`,
})
export class App {
  protected readonly vm = inject(AppShellViewModel);
}

import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { Toast } from '../core/toast/toast.store';

@Component({
  selector: 'app-toaster',
  imports: [NgIcon, HlmButtonImports],
  providers: [provideIcons({ lucideX })],
  template: `@if (toasts().length > 0) {
    <div class="k-toaster">
      @for (t of toasts(); track t.id) {
        <div class="k-toast" [class]="'k-toast--' + t.kind" role="alert">
          <span class="k-toast__dot"></span>
          <span class="k-toast__msg">{{ t.message }}</span>
          <button hlmBtn variant="ghost" size="icon-sm" aria-label="Dismiss" (click)="dismiss.emit(t.id)">
            <ng-icon name="lucideX" size="14" />
          </button>
        </div>
      }
    </div>
  }`,
})
export class Toaster {
  readonly toasts = input.required<Toast[]>();
  readonly dismiss = output<number>();
}

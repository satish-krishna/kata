import { Injectable, inject } from '@angular/core';
import { ToastStore } from './core/toast/toast.store';

@Injectable()
export class AppShellViewModel {
  private readonly toastStore = inject(ToastStore);
  readonly toasts = this.toastStore.toasts;

  dismiss(id: number): void {
    this.toastStore.dismiss(id);
  }
}

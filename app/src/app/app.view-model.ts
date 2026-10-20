import { Injectable, inject } from '@angular/core';
import { KataTransport } from './core/transport/kata-transport';
import { ToastStore } from './core/toast/toast.store';
import { zoomStepFor } from './lib/zoom-keys';

@Injectable()
export class AppViewModel {
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);

  /** Ctrl +, -, 0 zoom the whole window, on every route. */
  onKeydown(e: KeyboardEvent): void {
    const step = zoomStepFor(e);
    if (step === null) return;
    e.preventDefault();
    this.transport.zoom(step).catch((err: unknown) => this.toasts.error(`Failed to zoom: ${err}`));
  }
}

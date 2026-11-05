import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { RunningLine } from '../bindings/RunningLine';
import { KataTransport } from './core/transport/kata-transport';
import { ToastStore } from './core/toast/toast.store';
import { zoomStepFor } from './lib/zoom-keys';
import { VersionsStore } from './core/versions/versions.store';

@Injectable()
export class AppViewModel {
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);
  private readonly versionsStore = inject(VersionsStore);

  readonly versions = this.versionsStore.versions;
  windowFocused(): void {}
  async copyVersions(): Promise<void> {}

  /** The running changes the window's close asked about; null while nothing is asked. */
  readonly closeAsk = signal<RunningLine[] | null>(null);

  constructor() {
    const gone = inject(DestroyRef);
    let alive = true;
    let unlisten: (() => void) | null = null;
    gone.onDestroy(() => {
      alive = false;
      unlisten?.();
    });
    void this.transport.onCloseAsked((outcome) => {
      if (outcome.type === 'ask') this.closeAsk.set(outcome.running);
    }).then((off) => (alive ? (unlisten = off) : off()));
  }

  /** The engineer's answer goes to the backend, which stops every run and closes, or leaves the window and the runs alone. */
  answerClose(confirm: boolean): void {
    this.closeAsk.set(null);
    this.transport.sdlcCloseAnswer(confirm).catch((err: unknown) => this.toasts.error(`Failed to answer the close question: ${err}`));
  }

  /** Ctrl +, -, 0 zoom the whole window, on every route. */
  onKeydown(e: KeyboardEvent): void {
    const step = zoomStepFor(e);
    if (step === null) return;
    e.preventDefault();
    this.transport.zoom(step).catch((err: unknown) => this.toasts.error(`Failed to zoom: ${err}`));
  }
}

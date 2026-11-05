import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import type { RunningLine } from '../bindings/RunningLine';
import { KataTransport } from './core/transport/kata-transport';
import { ToastStore } from './core/toast/toast.store';
import { VersionsStore } from './core/versions/versions.store';
import { zoomStepFor } from './lib/zoom-keys';

/** The deepest route the router has activated. */
function leaf(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  return route.firstChild ? leaf(route.firstChild) : route;
}

@Injectable()
export class AppViewModel {
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);
  private readonly router = inject(Router);
  private readonly versionsStore = inject(VersionsStore);

  /** The running changes the window's close asked about; null while nothing is asked. */
  readonly closeAsk = signal<RunningLine[] | null>(null);

  /** The versions the line shows; null until the backend answers. */
  readonly versions = this.versionsStore.versions;

  /** Whether the shell draws the version line: every route except those whose data says `ownStatusBar`, which draw it in their own footer. */
  readonly shellLine = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => leaf(this.router.routerState.snapshot.root).data['ownStatusBar'] !== true),
    ),
    { initialValue: true },
  );

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
    void this.versionsStore.refresh();
  }

  /** The window regained focus: an ai-sdlc update or removal made elsewhere shows now. */
  windowFocused(): void {
    void this.versionsStore.refresh();
  }

  /** Clicking the line copies both versions as plain text. */
  copyVersions(): Promise<void> {
    return this.versionsStore.copy();
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

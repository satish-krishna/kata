import { Injectable, signal } from '@angular/core';

export type Toast = { id: number; kind: 'error'; message: string };
const TTL_MS = 6000;

/** Transient error notifications, rendered by the Toaster in the app shell. */
@Injectable({ providedIn: 'root' })
export class ToastStore {
  private readonly items = signal<Toast[]>([]);
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly toasts = this.items.asReadonly();

  error(message: string): number {
    const id = ++this.seq;
    this.items.update((xs) => [...xs, { id, kind: 'error', message }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), TTL_MS));
    return id;
  }

  /** Remove a toast and clear its timer. An unknown id is a no-op (no signal write). */
  dismiss(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    if (this.items().some((x) => x.id === id)) this.items.update((xs) => xs.filter((x) => x.id !== id));
  }
}

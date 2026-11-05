import { Injectable, inject, signal } from '@angular/core';
import type { Versions } from '@bindings/Versions';
import { ToastStore } from '../toast/toast.store';
import { KataTransport } from '../transport/kata-transport';

/** The versions the line along the bottom of the window shows. The backend writes both texts; this store only asks, holds and copies them. */
@Injectable({ providedIn: 'root' })
export class VersionsStore {
  private readonly transport = inject(KataTransport);
  private readonly toasts = inject(ToastStore);

  /** The last answer; null until the first one arrives, and kept when a later read fails. */
  readonly versions = signal<Versions | null>(null);

  /** Ask the backend again. A failed read leaves the line as it was. */
  async refresh(): Promise<void> {
    try {
      this.versions.set(await this.transport.appVersions());
    } catch {
      // The line keeps the last answer; nothing here is worth interrupting the engineer for.
    }
  }

  /** Put the copy text on the clipboard and say so. */
  async copy(): Promise<void> {
    const versions = this.versions();
    if (versions === null) return;
    try {
      await this.transport.copyText(versions.copy);
      this.toasts.success('Versions copied');
    } catch (err) {
      this.toasts.error(`Failed to copy the versions: ${err}`);
    }
  }
}

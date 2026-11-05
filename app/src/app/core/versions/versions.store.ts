import { Injectable, signal } from '@angular/core';
import type { Versions } from '@bindings/Versions';

@Injectable({ providedIn: 'root' })
export class VersionsStore {
  readonly versions = signal<Versions | null>(null);
  async refresh(): Promise<void> {}
  async copy(): Promise<void> {}
}

import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Mode } from '@bindings/Mode';
import type { Settings } from '@bindings/Settings';
import { KataTransport } from '../transport/kata-transport';

const ROUTE: Record<Mode, string> = { workbench: '/', sdlc: '/sdlc' };

/** Which mode the app is in: the persisted launch choice, and the switch between Workbench and AI-SDLC. */
@Injectable({ providedIn: 'root' })
export class ModeStore {
  private readonly transport = inject(KataTransport);
  private readonly router = inject(Router);

  private readonly state = signal<Settings | null>(null);
  readonly settings = this.state.asReadonly();

  private loading: Promise<Settings> | null = null;
  private launchedFlag = false;

  /** True once the operator has chosen, or the launch guard has run, this session. */
  get launched(): boolean {
    return this.launchedFlag;
  }

  /** The launch guard ran: later visits to the root route are the operator's own navigation, not a launch. */
  markLaunched(): void {
    this.launchedFlag = true;
  }

  /** Read the settings from the backend once; later calls return the cached value. */
  load(): Promise<Settings> {
    this.loading ??= this.transport
      .sdlcSettings()
      .then((s) => {
        this.state.set(s);
        return s;
      })
      .catch((e: unknown) => {
        // Do not cache a failure: the next call must retry the read.
        this.loading = null;
        throw e;
      });
    return this.loading;
  }

  /** Persist settings changed elsewhere (the AI-SDLC dialog) and keep the cached copy in step, so a later mode switch does not write stale values back. */
  async save(next: Settings): Promise<void> {
    await this.transport.sdlcSaveSettings(next);
    this.state.set(next);
    this.loading = Promise.resolve(next);
  }

  /** The launch dialog's answer. Without `remember` no mode is stored, so the next launch asks again. */
  async choose(mode: Mode, remember: boolean): Promise<void> {
    const current = await this.load();
    const next: Settings = { ...current, mode: remember ? mode : null, remember };
    await this.transport.sdlcSaveSettings(next);
    this.state.set(next);
    this.launchedFlag = true;
    await this.router.navigate([ROUTE[mode]]);
  }

  /** The toolbar badge. Persists the new mode only while the operator asked to be remembered. */
  async switchTo(mode: Mode): Promise<void> {
    const current = await this.load();
    this.launchedFlag = true;
    if (current.remember) {
      const next: Settings = { ...current, mode };
      await this.transport.sdlcSaveSettings(next);
      this.state.set(next);
    }
    await this.router.navigate([ROUTE[mode]]);
  }
}

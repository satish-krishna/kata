import { Injectable, inject, signal } from '@angular/core';
import type { Mode } from '@bindings/Mode';
import { ModeStore } from '../../core/mode/mode.store';
import { ToastStore } from '../../core/toast/toast.store';

@Injectable()
export class ModeScreenViewModel {
  private readonly modes = inject(ModeStore);
  private readonly toasts = inject(ToastStore);

  readonly selected = signal<Mode>('workbench');
  readonly remember = signal(true);

  select(mode: Mode): void {
    this.selected.set(mode);
  }

  setRemember(on: boolean): void {
    this.remember.set(on);
  }

  async open(): Promise<void> {
    try {
      await this.modes.choose(this.selected(), this.remember());
    } catch (e) {
      this.toasts.error(`Failed to save the mode: ${e}`);
    }
  }
}

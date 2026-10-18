import { Directive, input, signal } from '@angular/core';
import { injectExposesStateProvider } from '@spartan-ng/brain/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDialogContent],hlm-alert-dialog-content',
  exportAs: 'hlmAlertDialogContent',
  host: {
    'data-slot': 'alert-dialog-content',
    '[attr.data-state]': 'state()',
    '[attr.data-size]': 'size()',
  },
})
export class HlmAlertDialogContent {
  private readonly _stateProvider = injectExposesStateProvider({ optional: true, host: true });
  public readonly state = this._stateProvider?.state ?? signal('closed');

  public readonly size = input<'sm' | 'default'>('default');

  constructor() {
    classes(
      () =>
        'k-dialog group/alert-dialog-content relative flex flex-col gap-(--space-4) p-(--space-6) w-(--dialog-w) max-w-[calc(100vw-var(--space-8))] bg-(--surface-card) border border-(--border-default) rounded-(--radius-lg) [box-shadow:var(--shadow-lg)] outline-none',
    );
  }
}

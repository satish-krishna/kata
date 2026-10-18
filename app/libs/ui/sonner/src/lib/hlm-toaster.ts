import type { BooleanInput, NumberInput } from '@angular/cdk/coercion';
import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  afterNextRender,
  booleanAttribute,
  computed,
  input,
  numberAttribute,
} from '@angular/core';
import { BrnSonnerImports, type ToasterProps, toastState } from '@spartan-ng/brain/sonner';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { hlm } from '@spartan-ng/helm/utils';
import type { ClassValue } from 'clsx';

@Component({
  selector: 'hlm-toaster',
  exportAs: 'hlmToaster',
  imports: [BrnSonnerImports, HlmButtonImports],
  encapsulation: ViewEncapsulation.None,
  // Kata skin. Sonner's own rules are unlayered, so these live here (also unlayered) rather than in the
  // `components` layer of src/styles/kata, where they would lose to sonner at any specificity.
  styles: `
    [data-sonner-toast].k-toast[data-styled='true'] {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      box-shadow: var(--shadow-lg);
      font: var(--weight-medium) var(--text-sm) / 1.4 var(--font-sans);
    }
    /* sonner redefines --error-border inside the toaster, so derive from --error directly */
    [data-sonner-toast].k-toast--error[data-styled='true'] {
      border-color: color-mix(in srgb, var(--error) 42%, transparent);
    }
    .k-toast__dot {
      display: block;
      width: 8px;
      height: 8px;
      border-radius: var(--radius-full);
      background: var(--error);
      flex: none;
    }
    [data-sonner-toast].k-toast [data-icon] {
      margin: 0;
    }
    [data-sonner-toast].k-toast [data-content] {
      flex: 1;
    }
    [data-sonner-toast].k-toast .k-toast__close[data-close-button],
    [data-sonner-toast].k-toast:hover .k-toast__close[data-close-button]:hover {
      position: static;
      order: 1;
      transform: none;
      flex: none;
      width: auto;
      height: auto;
      padding: var(--space-1);
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-faint);
      cursor: pointer;
    }
    [data-sonner-toast].k-toast:hover .k-toast__close[data-close-button]:hover {
      color: var(--text-secondary);
    }
    [data-sonner-toast].k-toast .k-toast__close[data-close-button]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <brn-sonner-toaster
      [class]="_computedClass()"
      [invert]="invert()"
      [theme]="theme()"
      [position]="position()"
      [hotKey]="hotKey()"
      [richColors]="richColors()"
      [expand]="expand()"
      [duration]="duration()"
      [visibleToasts]="visibleToasts()"
      [closeButton]="closeButton()"
      [toastOptions]="_computedToastOptions()"
      [offset]="offset()"
      [style]="userStyle()"
    >
      <!-- Kata's andon pairing: an error is a crimson dot beside its message. The other toast types are unused, so their stock icons are emptied rather than shown. -->
      <ng-template #loadingIcon></ng-template>
      <ng-template #successIcon></ng-template>
      <ng-template #errorIcon><span class="k-toast__dot"></span></ng-template>
      <ng-template #infoIcon></ng-template>
      <ng-template #warningIcon></ng-template>
      <button
        *brnToastAction="let action; let toast = toast"
        [style]="toast.actionButtonStyle"
        hlmBtn
        size="sm"
        (click)="action.onClick($event)"
      >
        {{ action.label }}
      </button>
      <button
        *brnToastCancelAction="let cancel; let toast = toast"
        [style]="toast.cancelButtonStyle"
        hlmBtn
        size="sm"
        variant="secondary"
        (click)="cancel.onClick($event)"
      >
        {{ cancel.label }}
      </button>
    </brn-sonner-toaster>
  `,
})
export class HlmToaster {
  public readonly invert = input<ToasterProps['invert'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly theme = input<ToasterProps['theme']>('dark');
  public readonly position = input<ToasterProps['position']>('bottom-right');
  public readonly hotKey = input<ToasterProps['hotkey']>(['altKey', 'KeyT']);
  public readonly richColors = input<ToasterProps['richColors'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly expand = input<ToasterProps['expand'], BooleanInput>(true, {
    transform: booleanAttribute,
  });
  public readonly duration = input<ToasterProps['duration'], NumberInput>(4000, {
    transform: numberAttribute,
  });
  public readonly visibleToasts = input<ToasterProps['visibleToasts'], NumberInput>(3, {
    transform: numberAttribute,
  });
  public readonly closeButton = input<ToasterProps['closeButton'], BooleanInput>(true, {
    transform: booleanAttribute,
  });
  public readonly toastOptions = input<ToasterProps['toastOptions']>({});

  protected readonly _computedToastOptions = computed(() => {
    const options = this.toastOptions();
    return {
      ...options,
      classes: {
        ...options?.classes,
        toast: hlm('k-toast', options?.classes?.toast),
        error: hlm('k-toast--error', options?.classes?.error),
        closeButton: hlm('k-toast__close', options?.classes?.closeButton),
      },
    };
  });
  public readonly offset = input<ToasterProps['offset']>('var(--space-5)');
  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  public readonly userStyle = input<Record<string, string>>(
    {
      '--normal-bg': 'var(--surface-card)',
      '--normal-text': 'var(--text-primary)',
      '--normal-border': 'var(--border-default)',
      '--border-radius': 'var(--radius-md)',
    },
    { alias: 'style' },
  );

  protected readonly _computedClass = computed(() => hlm('toaster group', this.userClass()));

  constructor() {
    // Brain's toaster resets the global toast list when it is constructed, which would drop an error raised
    // before it mounted. Take the list here (the parent constructs first), then put it back once it has.
    const pending = toastState.toasts();
    if (pending.length > 0) {
      afterNextRender(() => {
        for (const t of [...pending].reverse()) toastState.addToast(t);
      });
    }
  }
}

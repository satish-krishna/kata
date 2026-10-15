import type { BooleanInput } from '@angular/cdk/coercion';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { BrnFieldControlDescribedBy } from '@spartan-ng/brain/field';
import { BrnSelectTrigger } from '@spartan-ng/brain/select';
import { hlm } from '@spartan-ng/helm/utils';
import type { ClassValue } from 'clsx';

@Component({
  selector: 'hlm-select-trigger',
  imports: [NgIcon, BrnSelectTrigger, BrnFieldControlDescribedBy],
  providers: [provideIcons({ lucideChevronDown })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      brnSelectTrigger
      brnFieldControlDescribedBy
      [forceInvalid]="forceInvalid()"
      [id]="buttonId()"
      [attr.aria-label]="ariaLabel()"
      [class]="_computedClass()"
      [attr.data-size]="size()"
      data-slot="select-trigger"
    >
      <ng-content />
      <ng-icon
        name="lucideChevronDown"
        class="ms-auto text-(color:--text-muted) text-[length:var(--icon-chevron)]"
      />
    </button>
  `,
})
export class HlmSelectTrigger {
  private static _id = 0;

  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  protected readonly _computedClass = computed(() =>
    hlm(
      'flex w-full items-center justify-between whitespace-nowrap cursor-pointer outline-none h-(--control-h) data-[size=sm]:h-(--control-h-sm) ps-(--space-4) pe-(--space-4) gap-(--space-3) bg-(--surface-inset) text-(color:--text-primary) border border-(--border-default) rounded-(--radius-sm) font-sans font-normal text-[length:var(--text-base)] leading-(--leading-normal) data-placeholder:text-(color:--text-placeholder) transition-[border-color] duration-(--dur-fast) ease-(--ease-out) hover:border-(--border-strong) focus:border-(--accent) focus:[box-shadow:0_0_0_3px_var(--accent-subtle)] not-hover:not-focus:data-[matches-spartan-invalid=true]:border-(--error-border) disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0',
      this.userClass(),
    ),
  );

  public readonly buttonId = input<string>(`hlm-select-trigger-${HlmSelectTrigger._id++}`);

  public readonly size = input<'default' | 'sm'>('default');

  /** Accessible name for the inner button when the visible value alone is not one. */
  public readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });

  /** Whether to force the trigger into an invalid state. */
  public readonly forceInvalid = input<boolean, BooleanInput>(false, {
    transform: booleanAttribute,
  });
}

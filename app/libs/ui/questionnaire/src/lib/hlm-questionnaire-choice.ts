import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';
import {
  BrnQuestionnaireChoice,
  BrnQuestionnaireChoiceInput,
  BrnQuestionnaireChoiceLabel,
  BrnQuestionnaireChoiceShortcut,
} from '@spartan-ng/brain/questionnaire';
import { classes } from '@spartan-ng/helm/utils';

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector -- attribute selector on native label
  selector: 'label[hlmQuestionnaireChoice]',
  exportAs: 'hlmQuestionnaireChoice',
  imports: [
    BrnQuestionnaireChoiceInput,
    BrnQuestionnaireChoiceLabel,
    BrnQuestionnaireChoiceShortcut,
    NgIcon,
  ],
  viewProviders: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [
    {
      directive: BrnQuestionnaireChoice,
      inputs: ['value', 'disabled', 'defaultChecked', 'checked'],
      outputs: ['checkedChange'],
    },
  ],
  host: {
    'data-slot': 'questionnaire-choice',
  },
  template: `
    <input
      brnQuestionnaireChoiceInput
      data-slot="questionnaire-choice-input"
      class="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
    />
    <span
      aria-hidden="true"
      data-slot="questionnaire-choice-indicator"
      class="pointer-events-none relative flex size-4 shrink-0 translate-y-px items-center justify-center rounded-(--radius-xs) border border-(--border-strong) bg-(--surface-card) transition-[background-color,border-color] duration-(--dur-fast) ease-(--ease-out) group-data-checked/questionnaire-choice:border-(--accent) group-data-checked/questionnaire-choice:bg-(--accent) group-data-checked/questionnaire-choice:text-(color:--text-on-accent) group-data-[type=radio]/questionnaire-choice:rounded-full"
    >
      @if (_choice.checked() && _choice.type() === 'radio') {
        <span
          data-slot="questionnaire-choice-indicator-dot"
          class="size-1.5 rounded-full bg-current"
        ></span>
      }
      @if (_choice.checked() && _choice.type() === 'checkbox') {
        <ng-icon
          name="lucideCheck"
          data-slot="questionnaire-choice-indicator-check"
          class="text-[length:11px]"
        />
      }
    </span>
    <span
      brnQuestionnaireChoiceLabel
      data-slot="questionnaire-choice-label"
      class="flex min-w-0 flex-1 flex-col gap-(--space-1) font-sans font-medium text-[length:var(--text-base)] leading-[1.3] text-(color:--text-primary)"
    >
      <ng-content />
    </span>
    @if (_choice.shortcut(); as shortcut) {
      <span
        brnQuestionnaireChoiceShortcut
        data-slot="questionnaire-choice-shortcut"
        class="pointer-events-none ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded-(--radius-xs) border border-(--border-default) bg-(--surface-card) font-mono text-[length:var(--text-2xs)] leading-none font-medium text-(color:--text-muted)"
      >
        {{ shortcut }}
      </span>
    }
  `,
})
export class HlmQuestionnaireChoice {
  protected readonly _choice = inject(BrnQuestionnaireChoice);

  constructor() {
    classes(
      () =>
        'group/questionnaire-choice relative flex cursor-pointer items-start gap-(--space-3) rounded-(--radius-sm) border border-(--border-default) bg-(--surface-inset) px-(--space-4) py-(--space-3) text-start select-none outline-none transition-[background-color,border-color] duration-(--dur-fast) ease-(--ease-out) hover:border-(--border-strong) hover:bg-(--surface-hover) data-checked:border-(--accent) data-checked:bg-(--accent-subtle) data-checked:hover:border-(--accent) data-checked:hover:bg-(--accent-subtle) has-[>input:focus-visible]:outline-solid has-[>input:focus-visible]:outline-2 has-[>input:focus-visible]:outline-offset-2 has-[>input:focus-visible]:outline-(--accent) data-invalid:border-(--error-border) data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-[0.55]',
    );
  }
}

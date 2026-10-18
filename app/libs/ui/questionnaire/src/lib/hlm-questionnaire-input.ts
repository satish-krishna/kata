import { Directive } from '@angular/core';
import { BrnQuestionnaireInput } from '@spartan-ng/brain/questionnaire';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'input[hlmQuestionnaireInput]',
  exportAs: 'hlmQuestionnaireInput',
  hostDirectives: [
    {
      directive: BrnQuestionnaireInput,
      inputs: ['type', 'disabled', 'value', 'defaultValue'],
    },
  ],
  host: {
    'data-slot': 'questionnaire-input',
  },
})
export class HlmQuestionnaireInput {
  constructor() {
    classes(() => [
      'h-(--control-h) w-full min-w-0 px-(--space-4) font-sans font-normal text-[length:var(--text-base)] leading-(--leading-normal) bg-(--surface-inset) text-(color:--text-primary) border border-(--border-default) rounded-(--radius-sm) transition-[border-color,background-color] duration-(--dur-fast) ease-(--ease-out) hover:border-(--border-strong) focus:outline-none focus:border-(--accent) focus:[box-shadow:0_0_0_3px_var(--accent-subtle)] aria-invalid:border-(--error-border) disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
      'placeholder:text-(color:--text-placeholder)',
    ]);
  }
}

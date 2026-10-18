import { Directive } from '@angular/core';
import { BrnQuestionnaireTitle } from '@spartan-ng/brain/questionnaire';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'legend[hlmQuestionnaireTitle]',
  exportAs: 'hlmQuestionnaireTitle',
  hostDirectives: [{ directive: BrnQuestionnaireTitle }],
  host: {
    'data-slot': 'questionnaire-title',
  },
})
export class HlmQuestionnaireTitle {
  constructor() {
    classes(
      () =>
        'font-sans font-medium text-[length:var(--text-md)] leading-[1.4] text-(color:--text-primary) [&:not(:has(~[data-slot=questionnaire-description]))]:mb-(--space-4) text-pretty',
    );
  }
}

import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmQuestionnaireChoiceDescription]',
  exportAs: 'hlmQuestionnaireChoiceDescription',
  host: {
    'data-slot': 'questionnaire-choice-description',
  },
})
export class HlmQuestionnaireChoiceDescription {
  constructor() {
    classes(() => 'font-sans font-normal text-[length:var(--text-xs)] leading-[1.45] text-(color:--text-muted)');
  }
}

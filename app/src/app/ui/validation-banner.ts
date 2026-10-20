import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

@Component({
  selector: 'app-validation-banner',
  imports: [NgIcon, HlmAlertImports],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './validation-banner.html',
})
export class ValidationBanner {
  readonly errors = input.required<string[]>();
}

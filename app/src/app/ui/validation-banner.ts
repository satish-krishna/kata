import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';

@Component({
  selector: 'app-validation-banner',
  imports: [NgIcon, HlmAlertImports],
  providers: [provideIcons({ lucideTriangleAlert })],
  template: `@if (errors().length > 0) {
    <hlm-alert variant="destructive" class="wb-banner wb-banner--error">
      <ng-icon name="lucideTriangleAlert" size="15" />
      <div hlmAlertDescription class="wb-banner__list">
        @for (e of errors(); track $index) {
          <span>{{ e }}</span>
        }
      </div>
    </hlm-alert>
  }`,
})
export class ValidationBanner {
  readonly errors = input.required<string[]>();
}

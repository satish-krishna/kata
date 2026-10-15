import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';

@Component({
  selector: 'app-validation-banner',
  imports: [NgIcon],
  providers: [provideIcons({ lucideTriangleAlert })],
  template: `@if (errors().length > 0) {
    <div class="wb-banner wb-banner--error" role="alert">
      <ng-icon name="lucideTriangleAlert" size="15" />
      <div class="wb-banner__list">
        @for (e of errors(); track $index) {
          <span>{{ e }}</span>
        }
      </div>
    </div>
  }`,
})
export class ValidationBanner {
  readonly errors = input.required<string[]>();
}

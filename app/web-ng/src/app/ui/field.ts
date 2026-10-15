import { Component, input } from '@angular/core';

@Component({
  selector: 'app-field',
  template: `<div class="k-field">
    <div class="k-field__label">
      {{ label() }}
      @if (key()) {
        <code>{{ key() }}</code>
      }
    </div>
    <ng-content />
    @if (hint()) {
      <div class="k-field__hint" [class.k-field__hint--error]="error()">{{ hint() }}</div>
    }
  </div>`,
})
export class Field {
  readonly label = input.required<string>();
  /** The literal spec key, shown in mono beside the label. */
  readonly key = input<string>();
  readonly hint = input<string>();
  readonly error = input(false);
}

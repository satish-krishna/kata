import { Component, input } from '@angular/core';

@Component({
  selector: 'app-field',
  templateUrl: './field.html',
})
export class Field {
  readonly label = input.required<string>();
  /** The literal spec key, shown in mono beside the label. */
  readonly key = input<string>();
  readonly hint = input<string>();
  readonly error = input(false);
}

import { Component, input } from '@angular/core';

@Component({
  selector: 'app-output-body',
  template: `<pre class="k-toolcard__out">{{ text() || '(no output)' }}</pre>
    @if (truncated()) {
      <div class="k-toolcard__trunc">… truncated at 256 KB</div>
    }`,
})
export class OutputBody {
  readonly text = input.required<string>();
  readonly truncated = input(false);
}

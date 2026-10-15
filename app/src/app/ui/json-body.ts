import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-json-body',
  template: `<pre class="k-toolcard__out">{{ json() }}</pre>`,
})
export class JsonBody {
  readonly value = input.required<unknown>();
  protected readonly json = computed(() => JSON.stringify(this.value(), null, 2));
}

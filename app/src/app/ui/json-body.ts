import { Component, computed, input } from '@angular/core';
import { HlmCodeBlockImports } from '@spartan-ng/helm/code-block';

@Component({
  selector: 'app-json-body',
  imports: [HlmCodeBlockImports],
  templateUrl: './json-body.html',
})
export class JsonBody {
  readonly value = input.required<unknown>();
  protected readonly json = computed(() => JSON.stringify(this.value(), null, 2));
}

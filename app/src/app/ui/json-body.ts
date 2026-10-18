import { Component, computed, input } from '@angular/core';
import { HlmCodeBlockImports } from '@spartan-ng/helm/code-block';

@Component({
  selector: 'app-json-body',
  imports: [HlmCodeBlockImports],
  template: `<hlm-code-block size="sm"><pre hlmCodeBlockContent wrap [code]="json()"></pre></hlm-code-block>`,
})
export class JsonBody {
  readonly value = input.required<unknown>();
  protected readonly json = computed(() => JSON.stringify(this.value(), null, 2));
}

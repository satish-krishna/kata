import { Component, input } from '@angular/core';
import { HlmCodeBlockImports } from '@spartan-ng/helm/code-block';

@Component({
  selector: 'app-output-body',
  imports: [HlmCodeBlockImports],
  template: `<hlm-code-block size="sm">
    <pre hlmCodeBlockContent wrap [code]="text() || '(no output)'"></pre>
    @if (truncated()) {
      <hlm-code-block-footer>… truncated at 256 KB</hlm-code-block-footer>
    }
  </hlm-code-block>`,
})
export class OutputBody {
  readonly text = input.required<string>();
  readonly truncated = input(false);
}

import { Component, input } from '@angular/core';
import { HlmCodeBlockImports } from '@spartan-ng/helm/code-block';

@Component({
  selector: 'app-output-body',
  imports: [HlmCodeBlockImports],
  templateUrl: './output-body.html',
})
export class OutputBody {
  readonly text = input.required<string>();
  readonly truncated = input(false);
}

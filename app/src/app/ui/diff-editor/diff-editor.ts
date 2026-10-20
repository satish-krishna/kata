import { Component, input } from '@angular/core';
import type { FilePair } from '@bindings/FilePair';

@Component({
  selector: 'app-diff-editor',
  templateUrl: './diff-editor.html',
})
export class DiffEditor {
  readonly pair = input<FilePair | null>(null);
  readonly sideBySide = input(true);

  nextChange(): void {}
  previousChange(): void {}
  updateModified(_text: string): void {}
}

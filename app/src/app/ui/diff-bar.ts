import { Component, computed, input, model, output } from '@angular/core';
import type { ChangedFile } from '@bindings/ChangedFile';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { FILE_STATUS } from './file-status';
import { Segmented } from './segmented';

export type DiffLayout = 'side' | 'inline';

const LAYOUTS: { value: DiffLayout; label: string }[] = [
  { value: 'side', label: 'Side by side' },
  { value: 'inline', label: 'Inline' },
];

/* The bar above the diff editor: what the open file is (status, path, rename, an uncommitted tag), the two steppers
 * between its changes, and the choice of side by side or inline. The parent owns the editor; the bar only says what to do. */
@Component({
  selector: 'app-diff-bar',
  imports: [HlmButtonImports, Segmented],
  templateUrl: './diff-bar.html',
})
export class DiffBar {
  readonly file = input<ChangedFile | null>(null);
  readonly layout = model<DiffLayout>('side');
  /** False below 768 pixels, where the editor is always inline and there is no choice to make. */
  readonly showLayout = input(true);
  readonly previous = output<void>();
  readonly next = output<void>();

  protected readonly layouts = LAYOUTS;
  protected readonly status = computed(() => {
    const f = this.file();
    return f === null ? null : FILE_STATUS[f.status];
  });
}

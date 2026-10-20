import { Component, input, output } from '@angular/core';

export type BuildDialogMode = 'start' | 'continue' | 'round';
export type BuildStartRequest = { timeoutSecs: number; instructions: string | null; repo: string | null };

@Component({
  selector: 'app-build-dialog',
  host: { class: 'contents' },
  templateUrl: './build-dialog.html',
})
export class BuildDialog {
  readonly open = input.required<boolean>();
  readonly mode = input.required<BuildDialogMode>();
  readonly repos = input.required<string[]>();
  readonly start = output<BuildStartRequest>();
  readonly cancel = output<void>();
}

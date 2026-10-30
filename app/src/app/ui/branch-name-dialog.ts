import { Component, input, output } from '@angular/core';
import type { NameRequest } from '../core/sdlc/sdlc-runner';
import type { WorkType } from '../lib/sdlc-naming';

/* Name the branch: the work type and the suggested name, editable. */
@Component({
  selector: 'app-branch-name-dialog',
  host: { class: 'contents' },
  templateUrl: './branch-name-dialog.html',
})
export class BranchNameDialog {
  readonly request = input<NameRequest | null>(null);

  readonly typeChange = output<WorkType>();
  readonly accept = output<string>();
  readonly cancel = output<void>();
}

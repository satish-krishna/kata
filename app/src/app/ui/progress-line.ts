import { Component, input } from '@angular/core';
import type { ProgressView } from '../core/progress/progress.store';

/* One long step's progress: the playful line (or the plain notice that a step runs long) and the plain label with its counts. */
@Component({
  selector: 'app-progress-line',
  templateUrl: './progress-line.html',
})
export class ProgressLine {
  readonly entry = input.required<ProgressView>();
}

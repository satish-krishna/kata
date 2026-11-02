import { Component } from '@angular/core';
import { RunningStripViewModel } from '../sdlc/running-strip.view-model';

/* The running-changes strip. Stub: renders nothing yet. */
@Component({
  selector: 'app-running-strip',
  providers: [RunningStripViewModel],
  templateUrl: './running-strip.html',
})
export class RunningStrip {}

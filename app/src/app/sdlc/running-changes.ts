import { Component, inject } from '@angular/core';
import { RunningStrip } from '../ui/running-strip';
import { RunningStripViewModel } from './running-strip.view-model';

/* The running-changes strip as the toolbars show it: the container that reads the backend's strip through its view model and
 * hands it to the presentational strip. Each page projects it into its toolbar, since no page passes the strip data. */
@Component({
  selector: 'app-running-changes',
  host: { class: 'contents' },
  imports: [RunningStrip],
  providers: [RunningStripViewModel],
  templateUrl: './running-changes.html',
})
export class RunningChanges {
  protected readonly vm = inject(RunningStripViewModel);
}

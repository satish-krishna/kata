import { Component } from '@angular/core';

/** The running-changes strip as the toolbars show it: a container over the strip's view model. */
@Component({
  selector: 'app-running-changes',
  host: { class: 'contents' },
  templateUrl: './running-changes.html',
})
export class RunningChanges {}

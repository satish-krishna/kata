import { Component, input } from '@angular/core';

/** The persistent note that says a long step was stopped: a warning dot and the words, as the change page and the home show it. */
@Component({
  selector: 'app-stopped-note',
  templateUrl: './stopped-note.html',
})
export class StoppedNote {
  readonly note = input.required<string>();
}

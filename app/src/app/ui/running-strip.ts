import { NgTemplateOutlet } from '@angular/common';
import { Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { RunningStripViewModel } from '../sdlc/running-strip.view-model';

/* The running-changes strip in both top bars: the backend's first entries and an "All running" list. Picking an entry
 * opens the change's session, where a question is answered (R14.1); the strip has no answer control of its own.
 * It sits in src/app/ui/ but reads its own view model, because both toolbars host it and no page passes it data. */
@Component({
  selector: 'app-running-strip',
  host: { class: 'contents' },
  imports: [NgTemplateOutlet, HlmButtonImports, HlmPopoverImports],
  providers: [RunningStripViewModel],
  templateUrl: './running-strip.html',
  styleUrl: './running-strip.css',
})
export class RunningStrip {
  protected readonly vm = inject(RunningStripViewModel);
}

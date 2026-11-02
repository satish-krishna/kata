import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterEveryRender, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { RunningStripViewModel } from '../sdlc/running-strip.view-model';

/* The running-changes strip in both top bars: the backend's first entries and an "All running" list. Picking an entry
 * opens the change's session, where a question is answered (R14.1); the strip has no answer control of its own.
 * It sits in src/app/ui/ but reads its own view model, because both toolbars host it and no page passes it data.
 * An entry that does not fit wraps out of the strip's one row and the row's height cuts it off, so it is made inert:
 * focus only reaches what is on show, and the All running list still reaches every entry. */
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private row: Element | null = null;
  private readonly watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.fit());

  constructor() {
    afterEveryRender(() => this.fit());
    inject(DestroyRef).onDestroy(() => this.watcher?.disconnect());
  }

  /** Mark every entry below the row inert, and follow the row's size so a wider or narrower toolbar re-marks them. */
  private fit(): void {
    const row = this.host.nativeElement.querySelector('.k-running');
    if (row !== this.row) {
      if (this.row !== null) this.watcher?.unobserve(this.row);
      if (row !== null) this.watcher?.observe(row);
      this.row = row;
    }
    if (row === null) return;
    const bottom = row.getBoundingClientRect().bottom;
    for (const entry of Array.from(row.querySelectorAll('.k-running__entry'))) {
      entry.toggleAttribute('inert', entry.getBoundingClientRect().top >= bottom - 1);
    }
  }
}

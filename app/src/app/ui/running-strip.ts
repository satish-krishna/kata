import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, afterEveryRender, effect, input, output, viewChild } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import type { RunChoice, StripPick, StripRow } from '../lib/running-strip';

/* The running-changes strip in both top bars: the entries it is given and an "All running" list. Picking an entry
 * says which row and run were picked; the container outside ui/ opens the change's session, where a question is
 * answered (R14.1); the strip has no answer control of its own.
 * An entry that does not fit wraps out of the strip's one row and the row's height cuts it off, so it is made inert:
 * focus only reaches what is on show, and the All running list still reaches every entry. */
@Component({
  selector: 'app-running-strip',
  host: { class: 'contents' },
  imports: [NgTemplateOutlet, HlmButtonImports, HlmPopoverImports],
  templateUrl: './running-strip.html',
  styleUrl: './running-strip.css',
})
export class RunningStrip {
  readonly shown = input<StripRow[]>([]);
  readonly all = input<StripRow[]>([]);
  readonly allLabel = input('');
  readonly pick = output<StripPick>();

  private readonly row = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.fit());

  constructor() {
    afterEveryRender(() => this.fit());
    // Follow the row's size so a wider or narrower toolbar re-marks the entries; the cleanup also runs when the strip goes.
    effect((onCleanup) => {
      const row = this.row()?.nativeElement;
      if (row === undefined || this.watcher === null) return;
      this.watcher.observe(row);
      onCleanup(() => this.watcher?.unobserve(row));
    });
  }

  protected choose(row: StripRow, choice: RunChoice | null): void {
    this.pick.emit({ row, choice });
  }

  /** Mark every entry below the row inert. */
  private fit(): void {
    const row = this.row()?.nativeElement;
    if (row === undefined) return;
    const bottom = row.getBoundingClientRect().bottom;
    for (const entry of Array.from(row.querySelectorAll('.k-running__entry'))) {
      entry.toggleAttribute('inert', entry.getBoundingClientRect().top >= bottom - 1);
    }
  }
}

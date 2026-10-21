import { Component, ElementRef, computed, input, linkedSignal, viewChild } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { outline } from '../lib/doc';
import { runResultLabel, type RunRow, type UsedBy } from '../lib/doc-rail';
import { MarkdownBody } from './markdown-body';

/** A heading counts as in view once it has scrolled up to this far below the top of the text column. */
const IN_VIEW_OFFSET = 24;

/* One change document, read-only, in three columns: an outline of its sections on the left, the text (left-aligned,
 * at most about 880px wide) in the middle, and a rail on the right with the front matter as label and value
 * fields, what uses this document, and its recent runs. Anything projected goes under the text. The text column
 * scrolls on its own, so the outline and the rail stay put. Headings are looked up inside this document's own
 * column, never by `document.getElementById`: another rendered document on the page can share an id. */
@Component({
  selector: 'app-doc-layout',
  host: { class: 'contents' },
  imports: [MarkdownBody, HlmButtonImports],
  templateUrl: './doc-layout.html',
})
export class DocLayout {
  /** The markdown to show, without its front matter. */
  readonly body = input.required<string>();
  readonly fields = input<[string, string][]>([]);
  readonly usedBy = input<UsedBy | null>(null);
  readonly runs = input<RunRow[]>([]);
  /** How many runs the stage has had; the rail lists only the latest. */
  readonly runTotal = input(0);

  protected readonly outcome = runResultLabel;
  protected readonly headings = computed(() => outline(this.body()).filter((h) => h.level === 2 || h.level === 3));
  /** The section in view: the first until the text scrolls, the clicked one after a click. */
  protected readonly active = linkedSignal<string | null>(() => this.headings()[0]?.id ?? null);
  private readonly column = viewChild.required<ElementRef<HTMLElement>>('column');

  /** The heading elements of this document's own text, by id. */
  private headingElements(): Map<string, HTMLElement> {
    const found = this.column().nativeElement.querySelectorAll<HTMLElement>('article h1, article h2, article h3, article h4, article h5, article h6');
    return new Map(Array.from(found, (h) => [h.id, h]));
  }

  protected go(id: string): void {
    this.active.set(id);
    this.headingElements().get(id)?.scrollIntoView?.({ block: 'start' });
  }

  /** The last section whose heading has reached the top of the column is the one in view. */
  protected onScroll(): void {
    const top = this.column().nativeElement.getBoundingClientRect().top;
    const elements = this.headingElements();
    let current = this.headings()[0]?.id ?? null;
    for (const h of this.headings()) {
      const el = elements.get(h.id);
      if (el === undefined) continue;
      if (el.getBoundingClientRect().top - top > IN_VIEW_OFFSET) break;
      current = h.id;
    }
    this.active.set(current);
  }
}

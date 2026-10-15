import { Component, computed, input } from '@angular/core';
import { renderMarkdownForDom } from './render-markdown';

@Component({
  selector: 'app-markdown-body',
  // Click handling is event delegation for the rendered markdown's own links,
  // which are independently keyboard-accessible; the div is not itself an
  // interactive widget, so no role or key handler belongs on it.
  template: `<div class="k-md" [innerHTML]="html()" (click)="onClick($event)"></div>`,
})
export class MarkdownBody {
  readonly md = input.required<string>();
  protected readonly html = computed(() => renderMarkdownForDom(this.md()));

  protected onClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    // Resolve to validate the scheme: block javascript:, data:, etc. and
    // only open over safe protocols. Open the original href so the URL is
    // passed through verbatim (no normalization surprises).
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return;
    }
    // Opens in the system browser under both a plain browser and Tauri.
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

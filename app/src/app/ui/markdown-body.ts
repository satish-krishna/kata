import { Component, ElementRef, afterRenderEffect, computed, input, viewChild } from '@angular/core';
import { diagrams, diagramTheme } from '../lib/mermaid';
import { renderMarkdownForDom } from './render-markdown';

@Component({
  selector: 'app-markdown-body',
  // Click handling is event delegation for the rendered markdown's own links,
  // which are independently keyboard-accessible; the div is not itself an
  // interactive widget, so no role or key handler belongs on it.
  template: `<div #root class="k-md" [innerHTML]="html()" (click)="onClick($event)"></div>`,
})
export class MarkdownBody {
  readonly md = input.required<string>();
  protected readonly html = computed(() => renderMarkdownForDom(this.md()));
  private readonly root = viewChild.required<ElementRef<HTMLElement>>('root');

  constructor() {
    // A Mermaid block arrives as plain code; once it is in the DOM, swap in the drawn diagram.
    afterRenderEffect(() => {
      this.html();
      const root = this.root().nativeElement;
      const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
      if (blocks.length === 0) return;
      const theme = diagramTheme(getComputedStyle(root));
      blocks.forEach((code) => void this.draw(code, theme));
    });
  }

  private async draw(code: HTMLElement, theme: ReturnType<typeof diagramTheme>): Promise<void> {
    const pre = code.parentElement!;
    try {
      const svg = await diagrams.render(code.textContent ?? '', theme);
      // The markdown may have changed while Mermaid worked; drop a result for a block that is gone.
      if (!pre.isConnected) return;
      const figure = document.createElement('div');
      figure.className = 'k-md__diagram';
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch (e) {
      if (!pre.isConnected) return;
      const note = document.createElement('p');
      note.className = 'k-md__diagram-error';
      note.textContent = `Diagram could not render: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
      pre.after(note);
    }
  }

  protected onClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest('a');
    if (!a) return;
    // Stop the webview navigating before any early return. A Mermaid link is an SVG <a> whose
    // target is in xlink:href, which getAttribute('href') does not see.
    e.preventDefault();
    const href = a.getAttribute('href') ?? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (!href) return;
    if (href.startsWith('#')) {
      // Under <base href="/"> a bare #x resolves to /#x, a full document reload
      // that wipes the root RunStore. Scroll in-page instead. Search this
      // rendered body first (footnote ids repeat across messages, so a
      // document-wide lookup would hit the wrong one), then the document.
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // malformed escape: use the raw id
      }
      if (!id) return;
      const host = e.currentTarget instanceof Element ? e.currentTarget : null;
      const local = host ? Array.from(host.querySelectorAll('[id]')).find((n) => n.id === id) : undefined;
      (local ?? document.getElementById(id))?.scrollIntoView();
      return;
    }
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

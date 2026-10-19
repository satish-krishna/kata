import { Component, input } from '@angular/core';
import { MarkdownBody } from './markdown-body';

/* One change document, read-only: its file name, the front matter as a single mono line, then the rendered body. */
@Component({
  selector: 'app-doc-view',
  imports: [MarkdownBody],
  template: `
    <article class="k-doc">
      <header class="k-doc__head">
        <span class="k-doc__name">{{ name() }}</span>
        @if (frontMatter(); as fm) {
          <span class="k-doc__front">{{ fm }}</span>
        }
      </header>
      <app-markdown-body [md]="body()" />
    </article>
  `,
})
export class DocView {
  readonly name = input.required<string>();
  readonly frontMatter = input<string | null>(null);
  readonly body = input.required<string>();
}

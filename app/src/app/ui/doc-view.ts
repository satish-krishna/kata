import { Component, input } from '@angular/core';
import { MarkdownBody } from './markdown-body';

/* One change document, read-only: its file name, the front matter as a single mono line, then the rendered body. */
@Component({
  selector: 'app-doc-view',
  imports: [MarkdownBody],
  templateUrl: './doc-view.html',
})
export class DocView {
  readonly name = input.required<string>();
  readonly frontMatter = input<string | null>(null);
  readonly body = input.required<string>();
}

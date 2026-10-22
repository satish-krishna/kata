import { Component, computed, input } from '@angular/core';
import { renderInlineMarkdownForDom } from './render-markdown';

/* One line of markdown, such as a task name, rendered in place with no paragraph around it and no links. */
@Component({
  selector: 'app-markdown-inline',
  templateUrl: './markdown-inline.html',
})
export class MarkdownInline {
  readonly md = input.required<string>();
  protected readonly html = computed(() => renderInlineMarkdownForDom(this.md()));
}

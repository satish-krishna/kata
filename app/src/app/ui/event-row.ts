import { Component, computed, input } from '@angular/core';
import { bodyFor, gutterFor, variantFor, type StreamEvent } from '../lib/events';
import { HlmMarkerImports } from '@spartan-ng/helm/marker';
import { MarkdownBody } from './markdown-body';

@Component({
  selector: 'app-event-row',
  imports: [MarkdownBody, HlmMarkerImports],
  template: `<div class="k-event" [class]="'k-event--' + variant()">
    @if (ev().type === 'turn') {
      <hlm-marker variant="separator">
        <hlm-marker-content>{{ gutter() }}</hlm-marker-content>
      </hlm-marker>
    } @else {
      <span class="k-event__gutter">{{ gutter() }}</span>
      <div class="k-event__body">
        @if (text() !== null) {
          <app-markdown-body [md]="text() ?? ''" />
        } @else {
          @if (tool()) {
            <span class="k-event__tool">{{ tool() }}</span
            >{{ ' ' }}
          }
          {{ body() }}
        }
      </div>
    }
  </div>`,
})
export class EventRow {
  readonly ev = input.required<StreamEvent>();
  protected readonly variant = computed(() => variantFor(this.ev()));
  protected readonly gutter = computed(() => gutterFor(this.ev()));
  protected readonly body = computed(() => bodyFor(this.ev()));
  protected readonly tool = computed(() => {
    const ev = this.ev();
    return ev.type === 'tool.use' || ev.type === 'tool.result' ? ev.name : null;
  });
  /** Markdown source for an assistant turn; null for every other event. */
  protected readonly text = computed(() => {
    const ev = this.ev();
    return ev.type === 'assistant.text' ? ev.text : null;
  });
}

import { Component, computed, forwardRef, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { HlmTraceImports } from '@spartan-ng/helm/trace';
import {
  STATUS_TEXT,
  defaultOpen,
  editsOf,
  inputOf,
  metaFor,
  rendererFor,
  statusOf,
  str,
  targetFor,
  todosOf,
  type ToolCall,
} from '../lib/toolcards';
import { DiffBody } from './diff-body';
import { EventRow } from './event-row';
import { JsonBody } from './json-body';
import { OutputBody } from './output-body';
import { TodoBody } from './todo-body';

@Component({
  selector: 'app-tool-card',
  imports: [
    NgIcon,
    HlmTraceImports,
    DiffBody,
    TodoBody,
    OutputBody,
    JsonBody,
    EventRow,
    forwardRef(() => ToolCard),
  ],
  providers: [provideIcons({ lucideChevronRight, lucideChevronDown })],
  templateUrl: './tool-card.html',
})
export class ToolCard {
  readonly call = input.required<ToolCall>();

  protected readonly renderer = computed(() => rendererFor(this.call()));
  protected readonly status = computed(() => statusOf(this.call()));
  protected readonly statusText = computed(() => STATUS_TEXT[this.status()]);
  /** null until the operator clicks: until then the default policy decides, so
   *  a call that fails after it rendered (running to error) still opens itself. */
  protected readonly toggled = signal<boolean | null>(null);
  protected readonly open = computed(() => this.toggled() ?? defaultOpen(this.call()));
  protected readonly inp = computed(() => inputOf(this.call()));
  protected readonly meta = computed(() => metaFor(this.call()));
  protected readonly target = computed(() => targetFor(this.call()));
  protected readonly output = computed(() => {
    const r = this.call().result;
    return r ? (r.output ?? r.summary) : '';
  });
  protected readonly outTruncated = computed(() => this.call().result?.truncated ?? false);
  protected readonly edits = computed(() => editsOf(this.call()));
  protected readonly todos = computed(() => todosOf(this.call()));
  /** Bespoke bodies show the tool own view; a failure message goes under it. */
  protected readonly showErrorOutput = computed(() => {
    const r = this.renderer();
    return (
      this.status() === 'error' &&
      (r === 'edit' || r === 'multiedit' || r === 'write' || r === 'todo')
    );
  });

  protected s(o: Record<string, unknown>, key: string): string {
    return str(o[key]);
  }
}

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
  template: `<hlm-trace-collapsible
    class="k-toolcard"
    [expanded]="open()"
    (expandedChange)="toggled.set($event)"
  >
    <button hlmTraceCollapsibleTrigger class="k-toolcard__row">
      <hlm-trace-line class="k-toolcard__line" [status]="status()">
        <hlm-trace-icon class="k-toolcard__chev">
          @if (open()) {
            <ng-icon name="lucideChevronDown" size="12" />
          } @else {
            <ng-icon name="lucideChevronRight" size="12" />
          }
        </hlm-trace-icon>
        <hlm-trace-icon>
          <span class="k-toolcard__dot" [class]="'k-toolcard__dot--' + status()"></span>
        </hlm-trace-icon>
        <hlm-trace-title class="k-toolcard__name">{{ call().use.name }}</hlm-trace-title>
        <hlm-trace-title class="k-toolcard__target">{{ target() }}</hlm-trace-title>
        <hlm-trace-description class="k-toolcard__meta">
          @if (meta().add !== undefined) {
            <span class="k-toolcard__add">+{{ meta().add }}</span>
          }
          @if (meta().del !== undefined) {
            <span class="k-toolcard__del">−{{ meta().del }}</span>
          }
          @if (meta().text) {
            <span>{{ meta().text }}</span>
          }
        </hlm-trace-description>
        <hlm-trace-description
          class="k-toolcard__status"
          [class]="'k-toolcard__status--' + status()"
          >{{ statusText() }}</hlm-trace-description
        >
      </hlm-trace-line>
    </button>

    <hlm-trace-collapsible-content>
      @if (open()) {
        <div class="k-toolcard__body">
          @switch (renderer()) {
            @case ('edit') {
              <app-diff-body
                [oldText]="s(inp(), 'old_string')"
                [newText]="s(inp(), 'new_string')"
              />
            }
            @case ('multiedit') {
              @for (e of edits(); track $index) {
                <app-diff-body [oldText]="s(e, 'old_string')" [newText]="s(e, 'new_string')" />
              }
            }
            @case ('write') {
              <app-diff-body oldText="" [newText]="s(inp(), 'content')" />
            }
            @case ('todo') {
              <app-todo-body [todos]="todos()" />
            }
            @case ('agent') {
              @if (s(inp(), 'prompt')) {
                <div class="k-toolcard__label">prompt</div>
                <div class="k-toolcard__prose">{{ s(inp(), 'prompt') }}</div>
              }
              @for (child of call().children; track child.key) {
                @if (child.kind === 'call') {
                  <app-tool-card [call]="child.call" />
                } @else {
                  <app-event-row [ev]="child.ev" />
                }
              }
              @if (call().result) {
                <div class="k-toolcard__label">result</div>
                <app-output-body [text]="output()" [truncated]="outTruncated()" />
              }
            }
            @case ('read') {
              <app-output-body [text]="output()" [truncated]="outTruncated()" />
            }
            @case ('search') {
              <app-output-body [text]="output()" [truncated]="outTruncated()" />
            }
            @default {
              <div class="k-toolcard__label">input</div>
              @if (call().use.input != null) {
                <app-json-body [value]="call().use.input" />
              } @else {
                <app-output-body
                  [text]="call().use.input_summary"
                  [truncated]="call().use.truncated ?? false"
                />
              }
              @if (call().result) {
                <div class="k-toolcard__label">output</div>
                <app-output-body [text]="output()" [truncated]="outTruncated()" />
              }
            }
          }
          @if (showErrorOutput()) {
            <app-output-body [text]="output()" [truncated]="outTruncated()" />
          }
        </div>
      }
    </hlm-trace-collapsible-content>
  </hlm-trace-collapsible>`,
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

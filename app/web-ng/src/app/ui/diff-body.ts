import { Component, computed, input } from '@angular/core';
import { diffLines } from 'diff';
import { DIFF_TIMEOUT_MS } from '../lib/toolcards';
import { OutputBody } from './output-body';

type Line = { kind: 'add' | 'del' | 'ctx'; text: string };
const MARK = { add: '+', del: '-', ctx: ' ' } as const;

@Component({
  selector: 'app-diff-body',
  imports: [OutputBody],
  template: `@if (lines(); as ls) {
    <div class="k-toolcard__diff">
      @for (l of ls; track $index) {
        <div class="k-toolcard__dl" [class]="'k-toolcard__dl--' + l.kind">
          <span class="k-toolcard__dm">{{ mark(l.kind) }}</span>{{ l.text }}</div>
      }
    </div>
  } @else {
    <div class="k-toolcard__label">before</div>
    <app-output-body [text]="oldText()" />
    <div class="k-toolcard__label">after</div>
    <app-output-body [text]="newText()" />
  }`,
})
export class DiffBody {
  readonly oldText = input.required<string>();
  readonly newText = input.required<string>();

  /** No line numbers: an Edit input carries no position in the file. `null`
   *  when the diff timed out; the template then shows the two texts as-is. */
  protected readonly lines = computed<Line[] | null>(() => {
    const parts = diffLines(this.oldText(), this.newText(), { timeout: DIFF_TIMEOUT_MS });
    if (!parts) return null;
    return parts.flatMap((part) => {
      const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx';
      return part.value
        .replace(/\n$/, '')
        .split('\n')
        .map((text): Line => ({ kind, text }));
    });
  });

  protected mark(kind: Line['kind']): string {
    return MARK[kind];
  }
}

import { Component, computed, input } from '@angular/core';
import { HlmCodeBlockImports } from '@spartan-ng/helm/code-block';
import { diffLines } from 'diff';
import { DIFF_TIMEOUT_MS } from '../lib/toolcards';
import { OutputBody } from './output-body';

type Line = { kind: 'add' | 'del' | 'ctx'; text: string };
const MARK = { add: '+', del: '-', ctx: ' ' } as const;

@Component({
  selector: 'app-diff-body',
  imports: [OutputBody, HlmCodeBlockImports],
  template: `@if (lines(); as ls) {
    <hlm-code-block size="sm" variant="flush"><pre hlmCodeBlockContent>@for (l of ls; track $index) {<span hlmCodeBlockLine [variant]="variant(l.kind)"><span class="k-toolcard__dm">{{ mark(l.kind) }}</span>{{ l.text }}</span>}</pre></hlm-code-block>
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

  protected variant(kind: Line['kind']): 'added' | 'removed' | 'default' {
    return kind === 'add' ? 'added' : kind === 'del' ? 'removed' : 'default';
  }

  protected mark(kind: Line['kind']): string {
    return MARK[kind];
  }
}

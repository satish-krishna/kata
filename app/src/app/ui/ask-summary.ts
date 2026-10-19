import { Component, input } from '@angular/core';
import { choicesOf, customAnswers } from '../lib/ask-form';
import type { Question, QuestionOption } from '../lib/events';

/** Read-only view of a settled ask: the questions with what the operator answered. */
@Component({
  selector: 'app-ask-summary',
  // The questions are items of the card body's column, so its gap separates them.
  host: { class: 'contents' },
  template: `
    @for (q of questions(); track $index; let i = $index) {
      <div class="k-ask__q">
        <div class="k-ask__q-head">
          <span class="k-ask__q-eyebrow">{{ q.header }}</span>
        </div>
        <div class="k-ask__q-text">{{ q.question }}</div>

        @if (q.kind === 'text') {
          <div class="k-ask__answer" [class.k-ask__answer--empty]="!textOf(i)">{{ textOf(i) || '(no answer)' }}</div>
        } @else if (chosen(q, i).length === 0 && custom(q, i).length === 0) {
          <div class="k-ask__answer k-ask__answer--empty">(skipped)</div>
        } @else {
          <div class="k-ask__opts">
            @for (opt of chosen(q, i); track opt.label) {
              <div class="k-ask__opt k-ask__opt--selected k-ask__opt--static">
                <span class="k-ask__opt-text">
                  <span class="k-ask__opt-label">{{ opt.label }}</span>
                  @if (opt.description) {
                    <span class="k-ask__opt-desc">{{ opt.description }}</span>
                  }
                </span>
              </div>
            }
            @if (custom(q, i).length > 0) {
              <div class="k-ask__opt k-ask__opt--selected k-ask__opt--static">
                <span class="k-ask__opt-text">
                  <span class="k-ask__opt-label">Other</span>
                  @for (c of custom(q, i); track $index) {
                    <span class="k-ask__opt-desc k-ask__other-answer">{{ c }}</span>
                  }
                </span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class AskSummary {
  readonly questions = input.required<Question[]>();
  readonly answers = input.required<string[][]>();

  protected answerAt(i: number): string[] {
    return this.answers()[i] ?? [];
  }

  protected textOf(i: number): string {
    return this.answerAt(i)[0] ?? '';
  }

  /** Listed choices the operator picked. */
  protected chosen(q: Question, i: number): QuestionOption[] {
    const a = this.answerAt(i);
    return choicesOf(q).filter((o) => a.includes(o.label));
  }

  protected custom(q: Question, i: number): string[] {
    return customAnswers(q, this.answerAt(i));
  }
}

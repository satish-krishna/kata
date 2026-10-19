import { Component, input } from '@angular/core';
import { choicesOf, customAnswers } from '../lib/ask-form';
import type { Question, QuestionOption } from '../lib/events';

/** Read-only view of a settled ask: the questions with what the operator answered. */
@Component({
  selector: 'app-ask-summary',
  // The questions are items of the card body's column, so its gap separates them.
  host: { class: 'contents' },
  templateUrl: './ask-summary.html',
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

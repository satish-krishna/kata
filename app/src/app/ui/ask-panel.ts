import { Component, ElementRef, computed, effect, input, output, signal, viewChildren } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type { AskRecord, Question, QuestionOption } from '../lib/events';

const YES_NO: QuestionOption[] = [{ label: 'Yes' }, { label: 'No' }];

@Component({
  selector: 'app-ask-panel',
  imports: [HlmButtonImports, HlmTextareaImports],
  template: `
    <div class="k-ask" [class.k-ask--answered]="answered()">
      <div class="k-ask__banner">
        <span class="k-ask__banner-dot"></span>
        <span class="k-ask__banner-label">{{ answered() ? 'answered · run resumed' : 'awaiting your input' }}</span>
        <span class="k-ask__banner-tool">ask_user</span>
      </div>
      <div class="k-ask__body">
        @for (q of ask().questions; track $index; let i = $index) {
          <div class="k-ask__q">
            <div class="k-ask__q-head">
              <span class="k-ask__q-eyebrow">{{ q.header }}</span>
              @if (q.kind === 'select' && q.multi_select) {
                <span class="k-ask__q-multi">choose any</span>
              }
            </div>
            <div class="k-ask__q-text">{{ q.question }}</div>

            @if (answered()) {
              @if (q.kind === 'text') {
                <div class="k-ask__answer" [class.k-ask__answer--empty]="!answeredText(i)">{{ answeredText(i) || '(no answer)' }}</div>
              } @else if (q.kind === 'confirm') {
                <div class="k-ask__confirm">
                  @for (opt of options(q); track opt.label) {
                    <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__confirm-btn" disabled
                      [class.k-ask__confirm-btn--selected]="answeredFirst(i) === opt.label">{{ opt.label }}</button>
                  }
                </div>
              } @else {
                <div class="k-ask__opts">
                  @for (opt of q.options ?? []; track opt.label) {
                    <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__opt" disabled
                      [class.k-ask__opt--selected]="answeredHas(i, opt.label)">
                      <span class="k-ask__mark" [class.k-ask__mark--check]="q.multi_select" [class.k-ask__mark--radio]="!q.multi_select">
                        @if (answeredHas(i, opt.label)) {
                          @if (q.multi_select) {
                            ✓
                          } @else {
                            <span class="k-ask__mark-dot"></span>
                          }
                        }
                      </span>
                      <span class="k-ask__opt-text">
                        <span class="k-ask__opt-label">{{ opt.label }}</span>
                        @if (opt.description) {
                          <span class="k-ask__opt-desc">{{ opt.description }}</span>
                        }
                      </span>
                    </button>
                  }
                  @if (customAnswers(q, i).length > 0) {
                    <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__opt k-ask__opt--selected" disabled>
                      <span class="k-ask__mark" [class.k-ask__mark--check]="q.multi_select" [class.k-ask__mark--radio]="!q.multi_select">
                        @if (q.multi_select) {
                          ✓
                        } @else {
                          <span class="k-ask__mark-dot"></span>
                        }
                      </span>
                      <span class="k-ask__opt-text">
                        <span class="k-ask__opt-label">Other</span>
                        @for (c of customAnswers(q, i); track $index) {
                          <span class="k-ask__opt-desc k-ask__other-answer">{{ c }}</span>
                        }
                      </span>
                    </button>
                  }
                </div>
              }
            } @else {
              @if (q.kind === 'confirm') {
                <div class="k-ask__confirm">
                  @for (opt of options(q); track opt.label) {
                    <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__confirm-btn"
                      [class.k-ask__confirm-btn--selected]="picked(i)[0] === opt.label"
                      (click)="pick(i, opt.label)">{{ opt.label }}</button>
                  }
                </div>
              } @else if (q.kind === 'select') {
                <div class="k-ask__opts">
                  @for (opt of q.options ?? []; track opt.label) {
                    <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__opt"
                      [class.k-ask__opt--selected]="picked(i).includes(opt.label)"
                      (click)="toggle(i, opt.label, !!q.multi_select)">
                      <span class="k-ask__mark" [class.k-ask__mark--check]="q.multi_select" [class.k-ask__mark--radio]="!q.multi_select">
                        @if (picked(i).includes(opt.label)) {
                          @if (q.multi_select) {
                            ✓
                          } @else {
                            <span class="k-ask__mark-dot"></span>
                          }
                        }
                      </span>
                      <span class="k-ask__opt-text">
                        <span class="k-ask__opt-label">{{ opt.label }}</span>
                        @if (opt.description) {
                          <span class="k-ask__opt-desc">{{ opt.description }}</span>
                        }
                      </span>
                    </button>
                  }
                  <button hlmBtn variant="bare" size="bare" type="button" class="k-ask__opt"
                    [class.k-ask__opt--selected]="otherIsOn(i)"
                    (click)="toggleOther(i, !!q.multi_select)">
                    <span class="k-ask__mark" [class.k-ask__mark--check]="q.multi_select" [class.k-ask__mark--radio]="!q.multi_select">
                      @if (otherIsOn(i)) {
                        @if (q.multi_select) {
                          ✓
                        } @else {
                          <span class="k-ask__mark-dot"></span>
                        }
                      }
                    </span>
                    <span class="k-ask__opt-text">
                      <span class="k-ask__opt-label">Other</span>
                      <span class="k-ask__opt-desc">type your own answer</span>
                    </span>
                  </button>
                  @if (otherIsOn(i)) {
                    <textarea hlmTextarea #other class="k-textarea" rows="2" placeholder="Your answer" autofocus
                      aria-label="Other answer" [value]="otherTextAt(i)"
                      (input)="setOtherText(i, $any($event.target).value)"></textarea>
                  }
                </div>
              } @else {
                <textarea hlmTextarea class="k-textarea" rows="3" [attr.placeholder]="q.placeholder ?? ''"
                  [value]="textAt(i)" (input)="setText(i, $any($event.target).value)"></textarea>
              }
            }
          </div>
        }
        @if (!answered()) {
          <div class="k-ask__foot">
            <span class="k-ask__hint">the run is paused on the leash</span>
            <button hlmBtn variant="primary" [disabled]="!ready()" (click)="send()">Send answer · resume</button>
          </div>
        }
      </div>
    </div>
  `,
})
export class AskPanel {
  readonly ask = input.required<AskRecord>();
  readonly answer = output<{ id: string; answers: string[][] }>();

  // Per-question operator state, keyed by question index. An absent key means untouched.
  private readonly selected = signal<Record<number, string[]>>({});
  private readonly text = signal<Record<number, string>>({});
  // Every select question carries a trailing "Other" row, as Claude Code's own
  // picker does: the operator is never boxed into the model's list. The typed
  // text travels as one more entry in that question's answer list.
  private readonly otherOn = signal<Record<number, boolean>>({});
  private readonly otherText = signal<Record<number, string>>({});

  private readonly otherEls = viewChildren<ElementRef<HTMLTextAreaElement>>('other');

  protected readonly answered = computed(() => this.ask().answers !== null);

  // Picking Other commits to typing something: an empty Other never sends.
  protected readonly ready = computed(() =>
    this.ask().questions.every((q, i) => {
      if (q.kind === 'select' && this.otherIsOn(i) && !this.otherTextAt(i).trim()) return false;
      if (q.optional) return true;
      return q.kind === 'text' ? this.textAt(i).trim().length > 0 : this.answerFor(q, i).length > 0;
    }),
  );

  constructor() {
    // Svelte's `autofocus` focused the Other textarea the moment it appeared.
    let prev = new Set<HTMLTextAreaElement>();
    effect(() => {
      const els = this.otherEls().map((e) => e.nativeElement);
      els.find((e) => !prev.has(e))?.focus();
      prev = new Set(els);
    });

  }

  protected options(q: Question): QuestionOption[] {
    return q.options ?? YES_NO;
  }

  protected picked(i: number): string[] {
    return this.selected()[i] ?? [];
  }
  protected textAt(i: number): string {
    return this.text()[i] ?? '';
  }
  protected otherIsOn(i: number): boolean {
    return this.otherOn()[i] ?? false;
  }
  protected otherTextAt(i: number): string {
    return this.otherText()[i] ?? '';
  }

  protected setText(i: number, v: string): void {
    this.text.update((m) => ({ ...m, [i]: v }));
  }
  protected setOtherText(i: number, v: string): void {
    this.otherText.update((m) => ({ ...m, [i]: v }));
  }
  protected pick(i: number, label: string): void {
    this.selected.update((m) => ({ ...m, [i]: [label] }));
  }

  protected toggle(i: number, label: string, multi: boolean): void {
    const cur = this.picked(i);
    if (multi) {
      this.selected.update((m) => ({ ...m, [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }));
    } else {
      this.pick(i, label);
      this.otherOn.update((m) => ({ ...m, [i]: false }));
    }
  }

  protected toggleOther(i: number, multi: boolean): void {
    if (multi) {
      this.otherOn.update((m) => ({ ...m, [i]: !this.otherIsOn(i) }));
    } else {
      this.selected.update((m) => ({ ...m, [i]: [] }));
      this.otherOn.update((m) => ({ ...m, [i]: true }));
    }
  }

  private answerFor(q: Question, i: number): string[] {
    if (q.kind === 'text') return [this.textAt(i)];
    const custom = q.kind === 'select' && this.otherIsOn(i) ? this.otherTextAt(i).trim() : '';
    const cur = this.picked(i);
    return custom && !cur.includes(custom) ? [...cur, custom] : cur;
  }

  protected send(): void {
    const a = this.ask();
    this.answer.emit({ id: a.id, answers: a.questions.map((q, i) => this.answerFor(q, i)) });
  }

  protected answeredText(i: number): string {
    return this.ask().answers?.[i]?.[0] ?? '';
  }
  protected answeredFirst(i: number): string | undefined {
    return this.ask().answers?.[i]?.[0];
  }
  protected answeredHas(i: number, label: string): boolean {
    return this.ask().answers?.[i]?.includes(label) ?? false;
  }

  /** Answers to a select question that are not among its listed labels. */
  protected customAnswers(q: Question, i: number): string[] {
    const labels = new Set((q.options ?? []).map((o) => o.label));
    return (this.ask().answers?.[i] ?? []).filter((a) => !labels.has(a));
  }
}

import { Component, Injector, computed, inject, input, output, signal, untracked } from '@angular/core';
import { form, FormField, FormRoot, metadata, REQUIRED, validate } from '@angular/forms/signals';
import { HlmQuestionnaireImports } from '@spartan-ng/helm/questionnaire';
import { choicesOf, emptyModel, fieldKey, isMulti, toAnswers, type AskModel } from '../lib/ask-form';
import type { AskRecord, Question } from '../lib/events';
import { AskSummary } from './ask-summary';

@Component({
  selector: 'app-ask-panel',
  imports: [FormRoot, FormField, HlmQuestionnaireImports, AskSummary],
  template: `
    <div class="k-ask" [class.k-ask--answered]="settled() !== null">
      <div class="k-ask__banner">
        <span class="k-ask__banner-dot"></span>
        <span class="k-ask__banner-label">{{ settled() !== null ? 'answered · run resumed' : 'awaiting your input' }}</span>
        <span class="k-ask__banner-tool">ask_user</span>
      </div>
      <div class="k-ask__body">
        @if (settled(); as answers) {
          <app-ask-summary [questions]="ask().questions" [answers]="answers" />
        } @else {
          <form hlmQuestionnaire [formRoot]="state().form" shortcuts="numbers">
            @if (ask().questions.length > 1) {
              <div hlmQuestionnaireProgress></div>
            }
            @for (q of ask().questions; track $index; let i = $index) {
              <fieldset hlmQuestionnaireItem [name]="key(i)" [multiple]="isMulti(q)" [formField]="state().form[key(i)]">
                <legend hlmQuestionnaireTitle>
                  <span class="k-ask__q-eyebrow">{{ q.header }}</span>
                  {{ q.question }}
                </legend>
                @if (isMulti(q)) {
                  <p hlmQuestionnaireDescription>choose any</p>
                }
                <div hlmQuestionnaireChoices #choices>
                  @for (opt of choicesOf(q); track opt.label) {
                    <label hlmQuestionnaireChoice [value]="opt.label" (checkedChange)="onChecked(choices, q, $event)">
                      {{ opt.label }}
                      @if (opt.description) {
                        <span hlmQuestionnaireChoiceDescription>{{ opt.description }}</span>
                      }
                    </label>
                  }
                  @if (q.kind === 'select') {
                    <input hlmQuestionnaireInput aria-label="Other answer" placeholder="Other — type your own answer" />
                  } @else if (q.kind === 'text') {
                    <input hlmQuestionnaireInput [attr.aria-label]="q.question" [attr.placeholder]="q.placeholder ?? ''" />
                  }
                </div>
                <p hlmQuestionnaireError></p>
              </fieldset>
            }
            <div class="k-ask__foot">
              <span class="k-ask__hint">the run is paused on the leash</span>
              <div hlmQuestionnaireActions>
                <button hlmQuestionnairePrevious>Previous</button>
                <button hlmQuestionnaireSkip>Skip</button>
                <button hlmQuestionnaireNext>Next</button>
                <button hlmQuestionnaireSubmit>Send answer · resume</button>
              </div>
            </div>
          </form>
        }
      </div>
    </div>
  `,
})
export class AskPanel {
  readonly ask = input.required<AskRecord>();
  readonly answer = output<{ id: string; answers: string[][] }>();

  // The Signal Form is built per ask, so it needs an injector outside a field initializer.
  private readonly injector = inject(Injector);

  protected readonly settled = computed(() => this.ask().answers);

  // Keyed on the ask id so a re-delivered record (same ask, new object) keeps what was typed.
  private readonly askId = computed(() => this.ask().id);

  // One Signal Form per ask. Keys exist only at runtime, so the model is a record. Whether a
  // key is required is per-ask data no schema owns, so it is a `validate()` emptiness check.
  protected readonly state = computed(() => {
    this.askId();
    const { id, questions } = untracked(() => this.ask());
    const model = signal<AskModel>(emptyModel(questions));
    const f = untracked(() => form(
      model,
      (p) => {
        questions.forEach((q, i) => {
          if (q.optional) return;
          // Marks the field required for the binding, so brain's item reports required and Skip is withheld.
          metadata(p[fieldKey(i)], REQUIRED, () => true);
          validate(p[fieldKey(i)], ({ value }) => {
            const v = value();
            const empty = Array.isArray(v) ? v.length === 0 : v.trim().length === 0;
            return empty ? { kind: 'required' } : undefined;
          });
        });
      },
      {
        injector: this.injector,
        submission: {
          action: async () => {
            this.answer.emit({ id, answers: toAnswers(questions, model()) });
          },
        },
      },
    ));
    return { form: f };
  });

  protected readonly key = fieldKey;
  protected readonly isMulti = isMulti;
  protected readonly choicesOf = choicesOf;

  /**
   * Picking a listed choice in a single-select drops the typed text from the value, but
   * brain leaves it visible. Clear it so the operator never sees text that will not be sent.
   */
  protected onChecked(choices: HTMLElement, q: Question, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (!checked || isMulti(q)) return;
    const free = choices.querySelector<HTMLInputElement>('input[hlmQuestionnaireInput]');
    if (free) free.value = '';
  }
}

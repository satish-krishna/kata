import { Component, Injector, computed, inject, input, output, signal, untracked } from '@angular/core';
import { FormField, REQUIRED, form, metadata, submit, validate } from '@angular/forms/signals';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Field } from './field';

export type BuildDialogMode = 'start' | 'continue' | 'round';
/** `instructions` and `repo` are set in round mode only. */
export type BuildStartRequest = { timeoutSecs: number; instructions: string | null; repo: string | null };

type BuildModel = { hours: number | null; minutes: number | null; instructions: string; repo: string };

const TITLES: Record<BuildDialogMode, string> = { start: 'Start build', continue: 'Continue build', round: 'Start round' };
const DEFAULT_HOURS = 2;

/* The build's start: the time limit for each repository's run and, for another round, what to do and where.
 * The form is rebuilt on every open, so a reopened dialog never shows the last answers. */
@Component({
  selector: 'app-build-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmInput, HlmSelectImports, HlmTextareaImports, FormField, Field],
  templateUrl: './build-dialog.html',
})
export class BuildDialog {
  readonly open = input.required<boolean>();
  readonly mode = input.required<BuildDialogMode>();
  /** The master repository first, then every repository the plan names. */
  readonly repos = input.required<string[]>();

  readonly start = output<BuildStartRequest>();
  readonly cancel = output<void>();

  private readonly injector = inject(Injector);

  protected readonly title = computed(() => TITLES[this.mode()]);
  protected readonly round = computed(() => this.mode() === 'round');

  protected readonly state = computed(() => {
    this.open();
    const model = signal<BuildModel>({ hours: DEFAULT_HOURS, minutes: 0, instructions: '', repo: '' });
    const isRound = () => untracked(() => this.round());
    const f = untracked(() =>
      form(
        model,
        (p) => {
          // The house lint rule reserves required()/min() for a zod schema, which this repo does not use; each rule is a validate(), as in ask-panel.
          for (const field of [p.hours, p.minutes]) {
            metadata(field, REQUIRED, () => true);
            validate(field, ({ value }) => (value() === null ? { kind: 'required' } : undefined));
            validate(field, ({ value }) => ((value() ?? 0) < 0 ? { kind: 'min' } : undefined));
          }
          validate(p.minutes, ({ valueOf }) => ((valueOf(p.hours) ?? 0) * 60 + (valueOf(p.minutes) ?? 0) > 0 ? undefined : { kind: 'zero-limit' }));
          metadata(p.instructions, REQUIRED, isRound);
          validate(p.instructions, ({ value }) => (isRound() && value().trim() === '' ? { kind: 'required' } : undefined));
          metadata(p.repo, REQUIRED, isRound);
          validate(p.repo, ({ value }) => (isRound() && value() === '' ? { kind: 'required' } : undefined));
        },
        { injector: this.injector },
      ),
    );
    return { model, form: f };
  });

  protected setRepo(repo: string | string[] | null | undefined): void {
    this.state().form.repo().value.set(typeof repo === 'string' ? repo : '');
  }

  protected submit(): Promise<boolean> {
    const { model, form: f } = this.state();
    return submit(f, async () => {
      const m = model();
      const round = this.round();
      this.start.emit({
        timeoutSecs: ((m.hours ?? 0) * 60 + (m.minutes ?? 0)) * 60,
        instructions: round ? m.instructions.trim() : null,
        repo: round ? m.repo : null,
      });
    });
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}

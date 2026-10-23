import { Component, Injector, computed, input, signal, type WritableSignal } from '@angular/core';
import { FormField, REQUIRED, form, metadata, validate, type FieldTree } from '@angular/forms/signals';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Field } from './field';

export type BuildDialogMode = 'start' | 'continue' | 'round';
/** `instructions` and `repo` are set in round mode only. */
export type BuildStartRequest = { timeoutSecs: number; instructions: string | null; repo: string | null };

export type BuildModel = { hours: number | null; minutes: number | null; instructions: string; repo: string };
/** The build's fields as a signal form; whoever owns the preview makes it and reads the request from it. */
export type BuildFormState = { model: WritableSignal<BuildModel>; form: FieldTree<BuildModel> };

const DEFAULT_HOURS = 2;

/** A fresh form for the build's time limit and, for another round, what to do and where. */
export function createBuildForm(injector: Injector, round: boolean): BuildFormState {
  const model = signal<BuildModel>({ hours: DEFAULT_HOURS, minutes: 0, instructions: '', repo: '' });
  const f = form(
    model,
    (p) => {
      // The house lint rule reserves required()/min() for a zod schema, which this repo does not use; each rule is a validate(), as in ask-panel.
      for (const field of [p.hours, p.minutes]) {
        metadata(field, REQUIRED, () => true);
        validate(field, ({ value }) => (value() === null ? { kind: 'required' } : undefined));
        validate(field, ({ value }) => ((value() ?? 0) < 0 ? { kind: 'min' } : undefined));
      }
      validate(p.minutes, ({ valueOf }) => ((valueOf(p.hours) ?? 0) * 60 + (valueOf(p.minutes) ?? 0) > 0 ? undefined : { kind: 'zero-limit' }));
      metadata(p.instructions, REQUIRED, () => round);
      validate(p.instructions, ({ value }) => (round && value().trim() === '' ? { kind: 'required' } : undefined));
      metadata(p.repo, REQUIRED, () => round);
      validate(p.repo, ({ value }) => (round && value() === '' ? { kind: 'required' } : undefined));
    },
    { injector },
  );
  return { model, form: f };
}

/** The time limit in seconds that the form holds now. */
export function limitSecs(state: BuildFormState): number {
  const m = state.model();
  return ((m.hours ?? 0) * 60 + (m.minutes ?? 0)) * 60;
}

/** What the form asks for. */
export function buildRequest(state: BuildFormState, round: boolean): BuildStartRequest {
  const m = state.model();
  return { timeoutSecs: limitSecs(state), instructions: round ? m.instructions.trim() : null, repo: round ? m.repo : null };
}

/* The build's fields: the time limit for each repository's run and, for another round, what to do and where.
 * The build's preview shows them in its top slot; the form is made by the preview's owner. */
@Component({
  selector: 'app-build-dialog',
  host: { class: 'contents' },
  imports: [HlmInput, HlmLabel, HlmSelectImports, HlmTextareaImports, FormField, Field],
  templateUrl: './build-dialog.html',
})
export class BuildDialog {
  readonly mode = input.required<BuildDialogMode>();
  /** The master repository first, then every repository the plan names. */
  readonly repos = input.required<string[]>();
  readonly state = input.required<BuildFormState>();

  protected readonly round = computed(() => this.mode() === 'round');

  protected setRepo(repo: string | string[] | null | undefined): void {
    this.state().form.repo().value.set(typeof repo === 'string' ? repo : '');
  }
}

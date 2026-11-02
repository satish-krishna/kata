import { Component, Injector, computed, input, signal, type WritableSignal } from '@angular/core';
import { FormField, REQUIRED, form, metadata, validate, type FieldTree } from '@angular/forms/signals';
import { NgTemplateOutlet } from '@angular/common';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmField, HlmFieldLabel } from '@spartan-ng/helm/field';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type { RoundFinding } from '@bindings/RoundFinding';
import type { RoundGroup } from '@bindings/RoundGroup';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import { summaryOf } from '../lib/build-task-list';
import type { Severity } from '../lib/sdlc';
import { Field } from './field';

export type BuildDialogMode = 'start' | 'continue' | 'round';
/** What the fields ask for: the time limit. A round's requests are the backend's plan, not the form's. */
export type BuildStartRequest = { timeoutSecs: number };

/** The time limit and, in round mode, the keys of the picked findings, the repository chosen for each finding that names none, and a note for each repository. */
export type BuildModel = { hours: number | null; minutes: number | null; picked: string[]; assigned: Record<string, string>; notes: Record<string, string> };
/** The build's fields as a signal form; whoever owns the preview makes it and reads the request from it. */
export type BuildFormState = { model: WritableSignal<BuildModel>; form: FieldTree<BuildModel> };

const DEFAULT_HOURS = 2;
const NO_OFFER: RoundOffer = { review: null, repos: [], findings: [] };

/** The entries of a picks record that hold a value. */
const definedOnly = (record: Partial<Record<string, string>> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(record ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));

/** The picks the form holds, as the backend's round plan reads them. */
export function picksOf(model: BuildModel): RoundPicks {
  return { picked: model.picked, assigned: model.assigned, notes: model.notes };
}

/** A fresh form for the build's time limit and, for another round, what to do and where. The findings picked to start with are the backend's `picks`. */
export function createBuildForm(injector: Injector, offer?: RoundOffer, picks?: RoundPicks): BuildFormState {
  const seen = offer ?? NO_OFFER;
  const model = signal<BuildModel>({
    hours: DEFAULT_HOURS,
    minutes: 0,
    picked: [...(picks?.picked ?? [])],
    assigned: definedOnly(picks?.assigned),
    notes: { ...Object.fromEntries(seen.repos.map((r) => [r, ''])), ...definedOnly(picks?.notes) },
  });
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
export function buildRequest(state: BuildFormState): BuildStartRequest {
  return { timeoutSecs: limitSecs(state) };
}

/* The build's fields: the time limit for each repository's run and, for another round, what to do and where.
 * The build's preview shows them in its top slot; the form is made by the preview's owner. */
@Component({
  selector: 'app-build-dialog',
  host: { class: 'contents' },
  imports: [NgTemplateOutlet, HlmCheckbox, HlmField, HlmFieldLabel, HlmInput, HlmLabel, HlmSelectImports, HlmTextareaImports, FormField, Field],
  templateUrl: './build-dialog.html',
})
export class BuildDialog {
  readonly mode = input.required<BuildDialogMode>();
  /** What a round may fix, from the latest review; null outside round mode. */
  readonly offer = input<RoundOffer | null>(null);
  /** The offer's findings in the Review group's groups and order, as the backend lists them. */
  readonly groups = input<RoundGroup[]>([]);
  /** What the round would start for the picks now made, as the backend answers; null until it has. */
  readonly plan = input<RoundPlan | null>(null);
  readonly state = input.required<BuildFormState>();

  protected readonly round = computed(() => this.mode() === 'round');
  private readonly seen = computed(() => this.offer() ?? NO_OFFER);
  protected readonly repos = computed(() => this.seen().repos);
  /** The build's repositories first, each with its findings and a note box, then the groups the build has no agent for (no note box). */
  protected readonly sections = computed<{ repo: string | null; findings: RoundFinding[]; note: boolean }[]>(() => {
    const groups = this.groups();
    const repos = this.repos();
    return [
      ...repos.map((repo) => ({ repo, findings: groups.find((g) => g.repo === repo)?.findings ?? [], note: true })),
      ...groups.filter((g) => g.repo === null || !repos.includes(g.repo)).map((g) => ({ repo: g.repo, findings: g.findings, note: false })),
    ];
  });

  protected isPicked(key: string): boolean {
    return this.state().model().picked.includes(key);
  }

  protected setPicked(key: string, on: boolean): void {
    this.state().model.update((m) => ({ ...m, picked: on ? [...m.picked.filter((k) => k !== key), key] : m.picked.filter((k) => k !== key) }));
  }

  protected assignedTo(key: string): string | null {
    return this.state().model().assigned[key] ?? null;
  }

  protected assign(key: string, repo: string | string[] | null | undefined): void {
    if (typeof repo !== 'string') return;
    this.state().model.update((m) => ({ ...m, assigned: { ...m.assigned, [key]: repo } }));
  }

  protected summaryOf(text: string): string {
    return summaryOf(text);
  }

  /** The status tone a severity takes, the way the findings list shows it. */
  protected tone(severity: Severity | null): string {
    return severity === 'critical' || severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'idle';
  }

}

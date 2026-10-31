import { Component, Injector, computed, input, signal, type WritableSignal } from '@angular/core';
import { FormField, REQUIRED, form, metadata, validate, type FieldTree } from '@angular/forms/signals';
import { NgTemplateOutlet } from '@angular/common';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmLabel } from '@spartan-ng/helm/label';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { defaultPicks, roundPlan, type RoundFinding, type RoundGroup, type RoundOffer, type RoundPicks, type RoundPlan, type RoundRequest } from '../lib/build-round';
import { summaryOf } from '../lib/build-task-list';
import type { Severity } from '../lib/sdlc';
import { Field } from './field';

export type BuildDialogMode = 'start' | 'continue' | 'round';
/** `rounds` is set in round mode only: one request per repository that gets an agent. */
export type BuildStartRequest = { timeoutSecs: number; rounds: RoundRequest[] | null };

/** The time limit and, in round mode, the keys of the picked findings, the repository chosen for each finding that names none, and a note for each repository. */
export type BuildModel = { hours: number | null; minutes: number | null; picked: string[]; assigned: Record<string, string>; notes: Record<string, string> };
/** The build's fields as a signal form; whoever owns the preview makes it and reads the request from it. */
export type BuildFormState = { model: WritableSignal<BuildModel>; form: FieldTree<BuildModel> };

const DEFAULT_HOURS = 2;
const NO_OFFER: RoundOffer = { review: null, repos: [], findings: [] };

/** The picks the form holds, as the round plan reads them. */
export function picksOf(model: BuildModel): RoundPicks {
  return { picked: new Set(model.picked), assigned: model.assigned, notes: model.notes };
}

/** A fresh form for the build's time limit and, for another round, what to do and where. */
export function createBuildForm(injector: Injector, round: boolean, offer?: RoundOffer): BuildFormState {
  const seen = offer ?? NO_OFFER;
  const model = signal<BuildModel>({
    hours: DEFAULT_HOURS,
    minutes: 0,
    picked: [...defaultPicks(seen).picked],
    assigned: {},
    notes: Object.fromEntries(seen.repos.map((r) => [r, ''])),
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
      // A round that cannot start reports why as the form's own error, so the preview's Start run stays off with the reason shown beside the picks.
      validate(p, ({ value }) => {
        const blocked = round ? roundPlan(seen, picksOf(value())).blocked : null;
        return blocked === null ? undefined : { kind: 'round', message: blocked };
      });
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
export function buildRequest(state: BuildFormState, round: boolean, offer?: RoundOffer): BuildStartRequest {
  return { timeoutSecs: limitSecs(state), rounds: round ? roundPlan(offer ?? NO_OFFER, picksOf(state.model())).requests : null };
}

/* The build's fields: the time limit for each repository's run and, for another round, what to do and where.
 * The build's preview shows them in its top slot; the form is made by the preview's owner. */
@Component({
  selector: 'app-build-dialog',
  host: { class: 'contents' },
  imports: [NgTemplateOutlet, HlmCheckbox, HlmInput, HlmLabel, HlmSelectImports, HlmTextareaImports, FormField, Field],
  templateUrl: './build-dialog.html',
})
export class BuildDialog {
  readonly mode = input.required<BuildDialogMode>();
  /** What a round may fix, from the latest review; null outside round mode. */
  readonly offer = input<RoundOffer | null>(null);
  /** The offer's findings in the Review group's groups and order, built by whoever owns the offer. */
  readonly groups = input<RoundGroup[]>([]);
  readonly state = input.required<BuildFormState>();

  protected readonly round = computed(() => this.mode() === 'round');
  private readonly seen = computed(() => this.offer() ?? NO_OFFER);
  protected readonly repos = computed(() => this.seen().repos);
  /** What the round asks of each repository, or why it cannot start. */
  protected readonly plan = computed<RoundPlan>(() => roundPlan(this.seen(), picksOf(this.state().model())));
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

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type { Stage } from '@bindings/Stage';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { stageLabel, type DocsPresent, type StepCounts } from '../lib/sdlc';

type StepName = keyof StepCounts;
type Tone = 'success' | 'warning' | 'error' | 'idle';
type Step = { name: StepName; title: string; current: boolean; text: string; tone: Tone; runs: string };

const STEPS: { name: StepName; title: string }[] = [
  { name: 'intent', title: 'Intent' },
  { name: 'spec', title: 'Spec' },
  { name: 'plan', title: 'Plan' },
];

const runs = (n: number): string => (n === 0 ? 'No runs' : n === 1 ? '1 run' : `${n} runs`);

/* The change page's three-step stage stepper. The current step carries the stage's label and tone; steps before it
 * read as accepted and steps after it as not started. Each tag is a dot plus a label, never color alone. A rejected
 * change is closed on the intent step. Each tile is also the tab for its document; the tabs root and the panels
 * belong to the change page, and a tile stays disabled until its document exists. */
@Component({
  selector: 'app-stage-stepper',
  imports: [HlmTabsImports, NgTemplateOutlet],
  template: `
    <div hlmTabsList variant="bare" class="k-steps" aria-label="Stage documents">
      <button hlmTabsTrigger="intent" variant="bare" class="k-step" [disabled]="!docs().intent" [attr.aria-current]="current('intent')">
        <ng-container *ngTemplateOutlet="tile; context: { $implicit: steps()[0] }" />
      </button>
      <button hlmTabsTrigger="spec" variant="bare" class="k-step" [disabled]="!docs().spec" [attr.aria-current]="current('spec')">
        <ng-container *ngTemplateOutlet="tile; context: { $implicit: steps()[1] }" />
      </button>
      <button hlmTabsTrigger="plan" variant="bare" class="k-step" [disabled]="!docs().plan" [attr.aria-current]="current('plan')">
        <ng-container *ngTemplateOutlet="tile; context: { $implicit: steps()[2] }" />
      </button>
    </div>
    <ng-template #tile let-s>
      <span class="k-step__name">{{ s.title }}</span>
      <span [class]="'k-status k-status--' + s.tone"><span class="k-status__dot"></span>{{ s.text }}</span>
      <span class="k-step__runs">{{ s.runs }}</span>
    </ng-template>
  `,
})
export class StageStepper {
  readonly stage = input.required<Stage>();
  readonly counts = input.required<StepCounts>();
  readonly docs = input.required<DocsPresent>();

  protected readonly steps = computed<Step[]>(() => {
    const label = stageLabel(this.stage());
    const at = STEPS.findIndex((s) => s.name === (label.step === 'closed' ? 'intent' : label.step));
    return STEPS.map((s, i) => {
      const base = { name: s.name, title: s.title, current: i === at, runs: runs(this.counts()[s.name]) };
      if (i === at) return { ...base, text: label.text, tone: label.tone === 'muted' ? 'idle' : label.tone };
      if (i < at) return { ...base, text: 'Accepted', tone: 'success' };
      return { ...base, text: 'Not started', tone: 'idle' };
    });
  });

  /** The three tabs are written out, not looped: their keys are fixed, and the primitive attribute stays static. */
  protected current(name: StepName): 'step' | null {
    return this.steps().find((s) => s.name === name)?.current ? 'step' : null;
  }
}

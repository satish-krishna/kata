import { Component, computed, input } from '@angular/core';
import type { Stage } from '@bindings/Stage';
import { stageLabel, type StepCounts } from '../lib/sdlc';

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
 * change is closed on the intent step. */
@Component({
  selector: 'app-stage-stepper',
  template: `
    <ol class="k-steps" aria-label="Stage">
      @for (s of steps(); track s.name) {
        <li class="k-step" [attr.aria-current]="s.current ? 'step' : null">
          <span class="k-step__name">{{ s.title }}</span>
          <span [class]="'k-status k-status--' + s.tone"><span class="k-status__dot"></span>{{ s.text }}</span>
          <span class="k-step__runs">{{ s.runs }}</span>
        </li>
      }
    </ol>
  `,
})
export class StageStepper {
  readonly stage = input.required<Stage>();
  readonly counts = input.required<StepCounts>();

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
}

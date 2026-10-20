import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type { Stage } from '@bindings/Stage';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { stageLabel, type DocsPresent, type StepCounts } from '../lib/sdlc';

type StepName = keyof DocsPresent | 'build';
type Tone = 'success' | 'warning' | 'error' | 'idle';
type Step = { name: StepName; title: string; current: boolean; text: string; tone: Tone; detail: string };

/** What the Build tile knows beyond the stage: whether a repository has the change's branch, and the build's tasks. */
export type BuildTile = { hasBranch: boolean; done: number; total: number; repos: number };
export const NO_BUILD_TILE: BuildTile = { hasBranch: false, done: 0, total: 0, repos: 0 };

const STEPS: { name: StepName; title: string }[] = [
  { name: 'intent', title: 'Intent' },
  { name: 'spec', title: 'Spec' },
  { name: 'plan', title: 'Plan' },
  { name: 'build', title: 'Build' },
];

const runs = (n: number): string => (n === 0 ? 'No runs' : n === 1 ? '1 run' : `${n} runs`);

/* The change page's four-step stage stepper. The current step carries the stage's label and tone; steps before it
 * read as accepted and steps after it as not started. Each tag is a dot plus a label, never color alone. A rejected
 * change is closed on the intent step. Each tile is also the tab for its panel; the tabs root and the panels
 * belong to the change page. A document tile stays disabled until its document exists. The Build tile is locked
 * until the plan is accepted, then waits for a repository to have the change's branch. */
@Component({
  selector: 'app-stage-stepper',
  imports: [HlmTabsImports, NgTemplateOutlet],
  templateUrl: './stage-stepper.html',
})
export class StageStepper {
  readonly stage = input.required<Stage>();
  readonly counts = input.required<StepCounts>();
  readonly docs = input.required<DocsPresent>();
  readonly build = input<BuildTile>(NO_BUILD_TILE);

  private readonly accepted = computed(() => {
    const step = stageLabel(this.stage()).step;
    return step === 'build' || step === 'done';
  });
  /** The Build tile cannot be opened before the plan is accepted, nor before any repository has the branch. */
  protected readonly buildDisabled = computed(() => !this.accepted() || !this.build().hasBranch);

  protected readonly steps = computed<Step[]>(() => {
    const label = stageLabel(this.stage());
    const tile = label.step === 'closed' ? 'intent' : label.step === 'done' ? 'build' : label.step;
    const at = STEPS.findIndex((s) => s.name === tile);
    return STEPS.map((s, i) => {
      const detail = s.name === 'build' ? this.buildDetail() : runs(this.counts()[s.name]);
      const base = { name: s.name, title: s.title, current: i === at, detail };
      if (s.name === 'build' && !this.accepted()) return { ...base, text: 'Build · locked until the plan is accepted', tone: 'idle' as const };
      if (i === at) return { ...base, text: label.text, tone: label.tone === 'muted' ? ('idle' as const) : label.tone };
      if (i < at) return { ...base, text: 'Accepted', tone: 'success' as const };
      return { ...base, text: 'Not started', tone: 'idle' as const };
    });
  });

  private buildDetail(): string {
    if (!this.accepted()) return '';
    const b = this.build();
    return this.counts().build === 0 ? 'no runs yet' : `${b.done}/${b.total} tasks · ${b.repos} repositories`;
  }

  /** The four tabs are written out, not looped: their keys are fixed, and the primitive attribute stays static. */
  protected current(name: StepName): 'step' | null {
    return this.steps().find((s) => s.name === name)?.current ? 'step' : null;
  }
}

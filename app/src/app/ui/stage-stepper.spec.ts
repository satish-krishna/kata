import type { Stage } from '@bindings/Stage';
import { render } from '../../testing/render';
import { StageStepper } from './stage-stepper';

const COUNTS = { intent: 2, spec: 1, plan: 0 };
const ALL: Stage[] = [
  'intent-in-progress', 'intent-awaiting', 'intent-accepted-uncommitted', 'rejected', 'spec-ready',
  'spec-awaiting', 'spec-accepted-uncommitted', 'plan-ready', 'plan-written', 'plan-superseded',
];
const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');

describe('StageStepper', () => {
  it.each(ALL)('marks exactly one step as current for %s', async (stage) => {
    const { container } = await render(StageStepper, { stage, counts: COUNTS });
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(container.querySelectorAll('li').length).toBe(3);
  });

  it('labels the current step from the stage and the others by position, each with a status dot', async () => {
    const { container } = await render(StageStepper, { stage: 'spec-awaiting', counts: COUNTS });
    const steps = Array.from(container.querySelectorAll('li'));
    expect(steps.map((s) => s.querySelector('.k-step__name')!.textContent!.trim())).toEqual(['Intent', 'Spec', 'Plan']);
    expect(steps[0].textContent).toContain('Accepted');
    expect(steps[1].getAttribute('aria-current')).toBe('step');
    expect(steps[1].textContent).toContain('Spec · awaiting acceptance');
    expect(steps[2].textContent).toContain('Not started');
    expect(container.querySelectorAll('.k-status__dot').length).toBe(3);
  });

  it('shows a rejected change as closed on the intent step', async () => {
    const { container } = await render(StageStepper, { stage: 'rejected', counts: COUNTS });
    const first = container.querySelector('li')!;
    expect(first.getAttribute('aria-current')).toBe('step');
    expect(first.textContent).toContain('Closed · rejected');
  });

  it('shows the run count per step', async () => {
    const { container } = await render(StageStepper, { stage: 'plan-ready', counts: COUNTS });
    const t = text(container);
    expect(t).toContain('2 runs');
    expect(t).toContain('1 run');
    expect(t).toContain('No runs');
  });
});

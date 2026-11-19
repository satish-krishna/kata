import { Component, computed, input, output, signal } from '@angular/core';
import type { FinishNext } from '@bindings/FinishNext';
import type { StartChecks } from '@bindings/StartChecks';
import { HlmButtonImports } from '@spartan-ng/helm/button';

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/** What happened to the agent after the check failed at finish, in words. */
const NEXT: Record<FinishNext, string> = {
  sentBackNotFixed: 'The agent was sent back to fix it and did not get it to pass.',
  stopped: 'The build stopped here.',
};

/* A failure at a repository's build finish, shown once on the Build tab: which check, why it blocks, its output on request, what happened
 * next, the checks that passed folded, and one action, running the checks again. It never offers to accept, because a check that passes
 * on the base and fails now is what the checks are for. The facts come from the backend's `finish`; this arranges them. The output is
 * interpolated text, never HTML. Presentational: running again and copying are the host's. */
@Component({
  selector: 'app-build-finish-panel',
  imports: [HlmButtonImports],
  templateUrl: './build-finish-panel.html',
  styleUrl: './build-failure-panel.css',
})
export class BuildFinishPanel {
  readonly start = input.required<StartChecks>();
  /** The engineer asked to run the checks again. */
  readonly rerun = output<void>();
  /** The output text the engineer asked to copy. */
  readonly copy = output<string>();

  protected readonly open = signal(false);

  protected readonly finish = computed(() => this.start().finish);
  protected readonly title = computed(() => {
    const f = this.finish();
    if (f === null) return '';
    return f.base === 'passed' ? `${f.check} failed at finish, and it passed on the base` : `${f.check} failed at finish, and this build added failures to it`;
  });
  protected readonly badge = computed(() => (this.finish()?.base === 'passed' ? 'new failure' : 'added failures'));
  protected readonly next = computed(() => NEXT[this.finish()?.next ?? 'stopped']);
  protected readonly lines = computed(() => lineCount(this.finish()?.output ?? ''));
  protected readonly passedWords = computed(() => {
    const n = this.finish()?.passed ?? 0;
    return `${n} other ${n === 1 ? 'check' : 'checks'} passed at finish`;
  });

  protected toggle(): void {
    this.open.update((was) => !was);
  }
}

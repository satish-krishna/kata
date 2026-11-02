import { Component, computed, input } from '@angular/core';
import type { CheckView } from '@bindings/CheckView';
import type { RepoCheckView } from '@bindings/RepoCheckView';

type Tone = 'success' | 'error' | 'warning' | 'idle';

/** The andon color of a state: jade for a pass, crimson for a failure of the work, amber for a fault of the machine, muted for the rest. */
const toneOf = (view: CheckView): Tone => {
  switch (view.kind) {
    case 'passed':
      return 'success';
    case 'failedFix':
    case 'failedStop':
      return 'error';
    case 'couldNotRun':
      return 'warning';
    default:
      return 'idle';
  }
};

/* A repository's checks as the plugin recorded them: its sentence, with the color and the dot, the checks that
 * passed, and for a check that did not pass its output exactly as the plugin gave it. The words are the
 * backend's; this only arranges them. */
@Component({
  selector: 'app-check-results',
  templateUrl: './check-results.html',
})
export class CheckResults {
  readonly views = input.required<RepoCheckView[]>();

  protected readonly shown = computed(() =>
    this.views().map((v) => ({
      repo: v.repo,
      summary: v.summary,
      tone: toneOf(v.view),
      hooks: v.view.kind === 'passed' ? v.view.hooks : [],
      output: 'output' in v.view ? v.view.output : null,
    })),
  );
}

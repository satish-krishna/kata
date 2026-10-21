import { Component, computed, input } from '@angular/core';
import { checkProblems, type DoneRepo } from '../lib/sdlc-done';

/* The checks that did not pass, one block each: which repository and check, how it ended, what to do about it and
 * the last lines of its output. A failure and a check that could not run are told apart by color and by words. */
@Component({
  selector: 'app-check-results',
  templateUrl: './check-results.html',
})
export class CheckResults {
  readonly repos = input.required<DoneRepo[]>();

  protected readonly problems = computed(() => checkProblems(this.repos()));
}

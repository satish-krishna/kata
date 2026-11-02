import { Component, computed, input, model, output } from '@angular/core';
import type { RepoCheckView } from '@bindings/RepoCheckView';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmLabel } from '@spartan-ng/helm/label';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTableImports } from '@spartan-ng/helm/table';
import {
  REVIEW_MISSING_TEXT,
  canConfirm,
  hasReview,
  highFindings,
  reviewedAt,
  type DoneReport,
} from '../lib/sdlc-done';
import { CheckResults } from './check-results';
import { FindingsList } from './findings-list';
import { MarkdownBody } from './markdown-body';

/* The confirmation before pull requests open: whether GitHub is ready, the branch of each repository and what the plugin recorded for its
 * checks, what failed, which commits break the rules, what departed from the plan and what the
 * review found. Open pull requests is the one primary action. It waits for everything but the medium, low and unrated
 * findings; a high-severity finding holds it until the engineer acknowledges opening the pull requests with it unresolved. */
@Component({
  selector: 'app-done-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmCheckbox, HlmLabel, HlmTableImports, CheckResults, FindingsList, MarkdownBody],
  templateUrl: './done-dialog.html',
})
export class DoneDialog {
  /** What to show; the dialog is open exactly while this is set. */
  readonly report = input.required<DoneReport | null>();
  /** The change folder, which names the branch in every repository. */
  readonly change = input.required<string>();

  readonly confirm = output<void>();
  readonly anotherRound = output<void>();
  readonly runReview = output<void>();
  readonly cancel = output<void>();

  /** The engineer's word that the pull requests open with the high-severity findings unresolved. */
  readonly acknowledged = model(false);

  protected readonly confirmable = computed(() => {
    const r = this.report();
    return r !== null && canConfirm(r, this.acknowledged());
  });

  /** How many high-severity findings hold Open pull requests; 0 when none does. */
  protected readonly highCount = computed(() => {
    const r = this.report();
    return r === null ? 0 : highFindings(r).length;
  });

  /** A round is offered whenever something blocks, and whenever the review left findings. */
  protected readonly roundOffered = computed(() => {
    const r = this.report();
    if (r === null) return false;
    return !canConfirm(r, this.acknowledged()) || (hasReview(r.review) && r.review.findings.length > 0);
  });

  protected readonly missingText = REVIEW_MISSING_TEXT;
  protected readonly reviewed = reviewedAt;
  protected readonly review = computed(() => {
    const r = this.report()?.review;
    return r && hasReview(r) ? r : null;
  });
  protected readonly missing = computed(() => {
    const r = this.report()?.review;
    return r && !hasReview(r) ? r.missing : null;
  });

  /** The checks the plugin recorded, one for each repository that has them. */
  protected readonly checks = computed<RepoCheckView[]>(() => (this.report()?.repos ?? []).flatMap((r) => (r.view === null ? [] : [r.view])));

  /** Escape closes the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.report() !== null) this.cancel.emit();
  }
}

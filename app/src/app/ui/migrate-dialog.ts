import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import type { MigratePlan } from '@bindings/MigratePlan';
import type { StepStatus } from '@bindings/StepStatus';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';

/** How each status the program reports reads, and which andon color its dot takes. The status itself is the program's. */
const STATUS: Record<StepStatus, { label: string; tone: string }> = {
  done: { label: 'done', tone: 'k-status--success' },
  would: { label: 'would do', tone: 'k-status--idle' },
  current: { label: 'already current', tone: 'k-status--idle' },
  manual: { label: 'by hand', tone: 'k-status--warning' },
  refused: { label: 'refused', tone: 'k-status--error' },
};

/* The migration of an ai-sdlc workspace to hoshin: the program's dry run as a list of steps, then, after Migrate, the same steps as written and
 * what is still left to do by hand. Migrate is enabled by the absence of problems and by nothing else. The host drives the dialog. */
@Component({
  selector: 'app-migrate-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports],
  templateUrl: './migrate-dialog.html',
})
export class MigrateDialog {
  readonly open = input.required<boolean>();
  /** The plan to show: the dry run, or the answer of the migration once it ran. */
  readonly plan = input.required<MigratePlan | null>();
  /** The migration ran: the steps are what was written, and Migrate is gone. */
  readonly done = input.required<boolean>();
  /** Whether Migrate is on: the plan has no problems and nothing is running. */
  readonly canMigrate = input.required<boolean>();
  /** The sentence the migration was refused or failed with. */
  readonly error = input.required<string | null>();

  /** The migration is running: the dialog cannot be closed until it ends, so the host reloads the page when it finishes. */
  readonly busy = input(false);

  readonly migrate = output<void>();
  readonly close = output<void>();

  protected status(s: StepStatus): { label: string; tone: string } {
    return STATUS[s];
  }

  /** Escape closes the overlay from inside; surface that as close. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open() && !this.busy()) this.close.emit();
  }
}

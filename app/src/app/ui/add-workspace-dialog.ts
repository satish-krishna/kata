import { Component, computed, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmTableImports } from '@spartan-ng/helm/table';
import {
  contextLabel,
  isSetUp,
  repoRows,
  systemNames,
  type RepoRole,
  type RepoRow,
  type WorkspaceCandidate,
} from '../lib/sdlc-workspace';

const ROLE: Record<RepoRole, string> = { master: 'master', product: 'product', 'not-checked-out': 'product' };

/* The result of kata's workspace check, shown before a folder joins the list: the systems, every repo with its
 * role and context state, and Add workspace. A folder with no repos, or with more than one marker, is explained
 * and cannot be added. */
@Component({
  selector: 'app-add-workspace-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, HlmTableImports],
  templateUrl: './add-workspace-dialog.html',
})
export class AddWorkspaceDialog {
  /** The scanned folder to confirm; the dialog is open exactly while this is set. */
  readonly candidate = input.required<WorkspaceCandidate | null>();

  readonly add = output<void>();
  readonly cancel = output<void>();

  protected readonly ready = computed(() => {
    const c = this.candidate();
    return c !== null && isSetUp(c.scan);
  });
  protected readonly masters = computed(() => {
    const m = this.candidate()?.scan.master;
    return m?.kind === 'many' ? m.repos : [];
  });
  protected readonly canAdd = computed(() => {
    const c = this.candidate();
    return c !== null && c.scan.repos.length > 0 && this.masters().length <= 1 && this.ready();
  });
  protected readonly systems = computed(() => {
    const c = this.candidate();
    return c ? systemNames(c.scan) : [];
  });
  protected readonly rows = computed<RepoRow[]>(() => {
    const c = this.candidate();
    return c ? repoRows(c.scan, c.contexts) : [];
  });

  protected role(role: RepoRole): string {
    return ROLE[role];
  }

  protected state(r: RepoRow) {
    return contextLabel(r.context);
  }

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.candidate()) this.cancel.emit();
  }
}

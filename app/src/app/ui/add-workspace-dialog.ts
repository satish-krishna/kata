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
  template: `
    <hlm-dialog [state]="candidate() ? 'open' : 'closed'" (stateChanged)="onState($event)">
      <hlm-dialog-content *hlmDialogPortal="let ctx">
        @if (candidate(); as c) {
          <div hlmDialogTitle>Add workspace</div>
          <div class="k-form">
            <p class="k-mono">{{ c.folder }}</p>
            @if (c.scan.repos.length === 0) {
              <p class="k-left__warn">No git repositories found in this folder. Nothing to add.</p>
            } @else if (masters().length > 1) {
              <p class="k-left__warn">A workspace has exactly one .ai-sdlc.json. Found it in:</p>
              <ul class="k-left__list">
                @for (m of masters(); track m) {
                  <li class="k-mono">{{ m }}</li>
                }
              </ul>
            } @else if (!ready()) {
              <p class="k-left__warn">This workspace is not set up yet: there is no committed .ai-sdlc.json.</p>
            } @else {
              <dl class="k-facts">
                <dt>Base branch</dt>
                <dd class="k-mono">{{ c.baseBranch }}</dd>
                <dt>Systems</dt>
                <dd class="k-mono">{{ systems().join(', ') }}</dd>
              </dl>
              <div hlmTableContainer>
                <table hlmTable>
                  <thead hlmTableHeader>
                    <tr hlmTableRow>
                      <th hlmTableHead>Repository</th>
                      <th hlmTableHead>Role</th>
                      <th hlmTableHead>Context</th>
                    </tr>
                  </thead>
                  <tbody hlmTableBody>
                    @for (r of rows(); track r.name) {
                      <tr hlmTableRow>
                        <td hlmTableCell class="k-mono">{{ r.name }}</td>
                        <td hlmTableCell>{{ role(r.role) }}</td>
                        <td hlmTableCell>
                          @if (r.role === 'master') {
                            <span class="k-faint">—</span>
                          } @else {
                            <span [class]="'k-status k-status--' + state(r).tone"><span class="k-status__dot"></span>{{ state(r).text }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
          <hlm-dialog-footer>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="cancel.emit()">{{ canAdd() ? 'Cancel' : 'Close' }}</button>
            @if (canAdd()) {
              <button hlmBtn variant="primary" size="sm" type="button" (click)="add.emit()">Add workspace</button>
            }
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
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

import { Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { contextAction, contextLabel, type RepoRole, type RepoRow } from '../lib/sdlc-workspace';

const ROLE: Record<RepoRole, string> = { master: 'master', product: 'product', 'not-checked-out': 'product' };

/* The workspace home's Repositories table: each repo, its role, its context state, and Run or Refresh
 * context on each product repo that is checked out. */
@Component({
  selector: 'app-repos-table',
  imports: [HlmButtonImports, HlmTableImports],
  template: `
    <div hlmTableContainer>
      <table hlmTable>
        <thead hlmTableHeader>
          <tr hlmTableRow>
            <th hlmTableHead>Repository</th>
            <th hlmTableHead>Role</th>
            <th hlmTableHead>Context</th>
            <th hlmTableHead><span class="sr-only">Actions</span></th>
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
                  <span [class]="'k-status k-status--' + state(r).tone">
                    <span class="k-status__dot"></span>{{ state(r).text }}
                  </span>
                }
              </td>
              <td hlmTableCell class="k-cell-end">
                @if (r.role !== 'master' && action(r); as label) {
                  <button
                    hlmBtn
                    variant="secondary"
                    size="sm"
                    type="button"
                    [attr.aria-label]="label + ' for ' + r.name"
                    [disabled]="disabled()"
                    (click)="runContext.emit(r.name)"
                  >{{ label }}</button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    @if (marker()) {
      <p class="k-marker">{{ marker() }}</p>
    }
  `,
})
export class ReposTable {
  readonly rows = input.required<RepoRow[]>();
  /** One line about the master repo's marker file. */
  readonly marker = input('');
  readonly disabled = input(false);

  readonly runContext = output<string>();

  protected role(role: RepoRole): string {
    return role === 'not-checked-out' ? 'product' : ROLE[role];
  }

  protected state(r: RepoRow) {
    return contextLabel(r.context);
  }

  protected action(r: RepoRow) {
    return contextAction(r.context);
  }
}

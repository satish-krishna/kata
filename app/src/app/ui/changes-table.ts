import { Component, computed, input, output } from '@angular/core';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { formatWhen } from '../lib/sdlc-workspace';
import { stageLabel } from '../lib/sdlc';

type Group = { system: string; changes: ChangeInfo[] };

/* The workspace home's Changes table: the changes on the checked-out branch grouped by system with their stage,
 * then a second group of change branches checked out elsewhere, shown by folder name and no stage. */
@Component({
  selector: 'app-changes-table',
  imports: [HlmButtonImports, HlmTableImports],
  template: `
    <div hlmTableContainer>
      <table hlmTable>
        <thead hlmTableHeader>
          <tr hlmTableRow>
            <th hlmTableHead>Change</th>
            <th hlmTableHead>Stage</th>
            <th hlmTableHead>Last run</th>
          </tr>
        </thead>
        @for (g of groups(); track g.system) {
          <tbody hlmTableBody [attr.data-testid]="'system-' + g.system">
            <tr hlmTableRow>
              <th hlmTableHead colspan="3" scope="colgroup" class="k-group">{{ g.system }}</th>
            </tr>
            @for (c of g.changes; track c.change) {
              <tr hlmTableRow>
                <td hlmTableCell>
                  <button
                    hlmBtn
                    variant="bare"
                    size="bare"
                    class="k-rowlink"
                    type="button"
                    [attr.aria-label]="'Open change ' + c.change"
                    [disabled]="disabled()"
                    (click)="open.emit(c)"
                  >{{ c.change }}</button>
                </td>
                <td hlmTableCell>
                  <span class="k-status" [class]="'k-status k-status--' + tone(c)">
                    <span class="k-status__dot"></span>{{ label(c) }}
                  </span>
                </td>
                <td hlmTableCell class="k-mono">{{ lastRun(c) }}</td>
              </tr>
            }
          </tbody>
        }
        @if (groups().length === 0) {
          <tbody hlmTableBody>
            <tr hlmTableRow>
              <td hlmTableCell colspan="3" class="k-empty-cell">No changes yet. Start one with New change.</td>
            </tr>
          </tbody>
        }
        @if (others().length > 0) {
          <tbody hlmTableBody data-testid="other-branches">
            <tr hlmTableRow>
              <th hlmTableHead colspan="3" scope="colgroup" class="k-group">In progress on other branches</th>
            </tr>
            @for (b of others(); track b) {
              <tr hlmTableRow>
                <td hlmTableCell colspan="3">
                  <button
                    hlmBtn
                    variant="bare"
                    size="bare"
                    class="k-rowlink"
                    type="button"
                    [attr.aria-label]="'Switch to branch change/' + b"
                    [disabled]="disabled()"
                    (click)="openOther.emit(b)"
                  >{{ b }}</button>
                </td>
              </tr>
            }
          </tbody>
        }
      </table>
    </div>
  `,
})
export class ChangesTable {
  /** Changes on the currently checked-out branch. */
  readonly changes = input.required<ChangeInfo[]>();
  /** Change folder names of change branches that are not checked out. */
  readonly others = input.required<string[]>();
  /** Latest run start (epoch seconds) per `<system>/<change>`. */
  readonly lastRuns = input<Record<string, number>>({});
  readonly disabled = input(false);

  readonly open = output<ChangeInfo>();
  readonly openOther = output<string>();

  protected readonly groups = computed<Group[]>(() => {
    const bySystem = new Map<string, ChangeInfo[]>();
    for (const c of this.changes()) bySystem.set(c.system, [...(bySystem.get(c.system) ?? []), c]);
    return [...bySystem].map(([system, changes]) => ({ system, changes }));
  });

  protected label(c: ChangeInfo): string {
    return stageLabel(c.stage).text;
  }

  protected tone(c: ChangeInfo): string {
    const t = stageLabel(c.stage).tone;
    return t === 'muted' ? 'idle' : t;
  }

  protected lastRun(c: ChangeInfo): string {
    const at = this.lastRuns()[`${c.system}/${c.change}`];
    return at === undefined ? '—' : formatWhen(at);
  }
}

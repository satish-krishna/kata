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
  templateUrl: './repos-table.html',
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

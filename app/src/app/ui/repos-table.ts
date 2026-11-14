import { Component, input, output } from '@angular/core';
import type { AppHealth } from '@bindings/AppHealth';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTableImports } from '@spartan-ng/helm/table';
import { contextAction, contextLabel, type RepoRole, type RepoRow, type Tone } from '../lib/sdlc-workspace';

/** How an app's context file reads on the home: the words and the tone. The action it offers is the backend's. */
function appContext(h: AppHealth['context']): { text: string; tone: Tone } {
  switch (h.kind) {
    case 'current':
      return { text: 'current', tone: 'success' };
    case 'behind':
      return { text: `out of date · ${h.commits} ${h.commits === 1 ? 'commit' : 'commits'}`, tone: 'warning' };
    case 'missing':
      return { text: 'missing', tone: 'error' };
    case 'noSourceCommit':
      return { text: 'no source commit', tone: 'warning' };
    case 'unknownCommit':
      return { text: 'unknown commit', tone: 'warning' };
  }
}

const ROLE: Record<RepoRole, string> = { master: 'master', product: 'product', 'not-checked-out': 'product' };

/* The workspace home's Repositories table: each repo, its role, its context state, View to read its context file,
 * and Run or Refresh context on each product repo that is checked out. */
@Component({
  selector: 'app-repos-table',
  imports: [HlmButtonImports, HlmTableImports],
  templateUrl: './repos-table.html',
})
export class ReposTable {
  readonly rows = input.required<RepoRow[]>();
  /** The apps of a single-repo system, one row each with no master row; null lists the repositories of a workspace instead. */
  readonly apps = input<AppHealth[] | null>(null);
  /** One line about the master repo's marker file. */
  readonly marker = input('');
  readonly disabled = input(false);

  readonly runContext = output<string>();
  /** Open the context viewer on a repo. */
  readonly viewContext = output<string>();

  protected appState(a: AppHealth) {
    return appContext(a.context);
  }

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

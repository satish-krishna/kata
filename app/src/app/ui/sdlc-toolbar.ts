import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideGitBranch, lucideSettings } from '@ng-icons/lucide';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { WorkspaceSwitcher } from './workspace-switcher';

/* The AI-SDLC toolbar: seal, mode badge, workspace switcher, breadcrumb, the master repo's branch, settings, and
 * what the screen projects: stage pills after the branch (`toolbarStages`), links before settings
 * (`toolbarLinks`), and the screen's one primary action last. */
@Component({
  selector: 'app-sdlc-toolbar',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, WorkspaceSwitcher],
  providers: [provideIcons({ lucideChevronRight, lucideGitBranch, lucideSettings })],
  templateUrl: './sdlc-toolbar.html',
})
export class SdlcToolbar {
  readonly workspaces = input.required<WorkspaceEntry[]>();
  readonly current = input.required<WorkspaceEntry | null>();
  readonly missing = input<string[]>([]);
  readonly counts = input<Record<string, number>>({});
  /** The master repo's checked-out branch, shown in mono so nobody is surprised where a commit lands. */
  readonly branch = input.required<string | null>();
  /** Crumbs after the workspace name. */
  readonly crumbs = input<string[]>([]);
  /** A tag beside the crumbs, such as `fix` for a change on the light track; none when null. */
  readonly tag = input<string | null>(null);
  /** The first crumb's label: the way back to the changes list. Null where there is nowhere to go back to (the home page). */
  readonly back = input<string | null>(null);
  /** A run or locked operation is in progress. */
  readonly locked = input(false);
  /** Nothing in a workspace can be acted on (the ai-sdlc plugin is missing), so the workspace controls are withheld. */
  readonly blocked = input(false);

  /** The chip's title and accessible name: the full branch, and on a change page the branch it should be on, so the icon form says all the text does. */
  protected readonly branchLabel = computed(() => {
    const change = this.crumbs()[0];
    return `Master repository is on ${this.branch()}${change ? `, not change/${change}` : ''}`;
  });

  readonly switchMode = output<void>();
  readonly select = output<string>();
  readonly add = output<void>();
  readonly remove = output<void>();
  readonly openSettings = output<void>();
  readonly goBack = output<void>();
}

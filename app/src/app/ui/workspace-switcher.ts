import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideFolderPlus, lucideX } from '@ng-icons/lucide';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';

/* The toolbar's workspace switcher: a dropdown on the workspace name. It lists every known workspace with its
 * folder, checks the current one, flags a folder that is gone, and ends with Add workspace… and
 * Remove from list… (removing only forgets the workspace; nothing on disk is touched). */
@Component({
  selector: 'app-workspace-switcher',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideFolderPlus, lucideX })],
  templateUrl: './workspace-switcher.html',
})
export class WorkspaceSwitcher {
  readonly workspaces = input.required<WorkspaceEntry[]>();
  readonly current = input.required<WorkspaceEntry | null>();
  /** Ids of workspaces whose folder no longer exists. */
  readonly missing = input<string[]>([]);
  /** A run or locked operation is in progress. */
  readonly locked = input(false);

  /** The name the trigger shows. It is cut with an ellipsis when the toolbar is short of room, so the trigger repeats it in its title and accessible name. */
  protected readonly name = computed(() => this.current()?.name ?? 'No workspace');

  readonly select = output<string>();
  readonly add = output<void>();
  readonly remove = output<void>();

  protected onPick(id: string): void {
    if (id !== this.current()?.id) this.select.emit(id);
  }
}

import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideFolderPlus, lucideX } from '@ng-icons/lucide';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';

/* The toolbar's workspace switcher: a dropdown on the workspace name. It lists every known workspace with its
 * folder and change count, checks the current one, flags a folder that is gone, and ends with Add workspace… and
 * Remove from list… (removing only forgets the workspace; nothing on disk is touched). */
@Component({
  selector: 'app-workspace-switcher',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideFolderPlus, lucideX })],
  template: `
    <button
      hlmBtn
      variant="bare"
      size="bare"
      class="k-wstrigger"
      type="button"
      aria-label="Switch workspace"
      [hlmDropdownMenuTrigger]="menu"
      [disabled]="locked()"
    >
      <span class="k-wstrigger__name">{{ current()?.name ?? 'No workspace' }}</span>
      <ng-icon name="lucideChevronDown" size="14" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu>
        @if (workspaces().length) {
          <hlm-dropdown-menu-label>Workspaces</hlm-dropdown-menu-label>
          @for (w of workspaces(); track w.id) {
            <button hlmDropdownMenuRadio type="button" [checked]="w.id === current()?.id" [keepOpen]="false" (triggered)="onPick(w.id)">
              <span class="k-wsitem">
                <span class="k-wsitem__name">{{ w.name }}</span>
                <span class="k-wsitem__folder">{{ w.folder }}</span>
                @if (missing().includes(w.id)) {
                  <span class="k-wsitem__note k-wsitem__note--warn">folder missing</span>
                } @else if (counts()[w.id] !== undefined) {
                  <span class="k-wsitem__note">{{ counts()[w.id] }} {{ counts()[w.id] === 1 ? 'change' : 'changes' }}</span>
                }
              </span>
              <hlm-dropdown-menu-radio-indicator />
            </button>
          }
          <hlm-dropdown-menu-separator />
        }
        <button hlmDropdownMenuItem type="button" (triggered)="add.emit()">
          <ng-icon name="lucideFolderPlus" />Add workspace…
        </button>
        @if (current()) {
          <button hlmDropdownMenuItem type="button" (triggered)="remove.emit()">
            <ng-icon name="lucideX" />Remove from list…
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class WorkspaceSwitcher {
  readonly workspaces = input.required<WorkspaceEntry[]>();
  readonly current = input.required<WorkspaceEntry | null>();
  /** Ids of workspaces whose folder no longer exists. */
  readonly missing = input<string[]>([]);
  /** Change count per workspace id, where known. */
  readonly counts = input<Record<string, number>>({});
  /** A run or locked operation is in progress. */
  readonly locked = input(false);

  readonly select = output<string>();
  readonly add = output<void>();
  readonly remove = output<void>();

  protected onPick(id: string): void {
    if (id !== this.current()?.id) this.select.emit(id);
  }
}

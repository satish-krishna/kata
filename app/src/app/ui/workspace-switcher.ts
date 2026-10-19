import { Component, input, output } from '@angular/core';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmSelectImports } from '@spartan-ng/helm/select';

/* The toolbar's workspace picker: a select whose value is the current workspace. Each option shows the folder and
 * the change count and flags a folder that is gone. Add and Remove are separate toolbar buttons, not options. */
@Component({
  selector: 'app-workspace-switcher',
  host: { class: 'contents' },
  imports: [HlmSelectImports],
  template: `
    <div class="k-wsswitch">
      <hlm-select [value]="current()?.id ?? null" [itemToString]="nameOf" (valueChange)="onPick($event)">
        <hlm-select-trigger aria-label="Switch workspace">
          <hlm-select-value placeholder="No workspace" />
        </hlm-select-trigger>
        <hlm-select-content *hlmSelectPortal>
          @for (w of workspaces(); track w.id) {
            <hlm-select-item [value]="w.id">
              <span class="k-wsitem">
                <span class="k-wsitem__name">{{ w.name }}</span>
                <span class="k-wsitem__folder">{{ w.folder }}</span>
                @if (missing().includes(w.id)) {
                  <span class="k-wsitem__note k-wsitem__note--warn">folder missing</span>
                } @else if (counts()[w.id] !== undefined) {
                  <span class="k-wsitem__note">{{ counts()[w.id] }} {{ counts()[w.id] === 1 ? 'change' : 'changes' }}</span>
                }
              </span>
            </hlm-select-item>
          }
        </hlm-select-content>
      </hlm-select>
    </div>
  `,
})
export class WorkspaceSwitcher {
  readonly workspaces = input.required<WorkspaceEntry[]>();
  readonly current = input.required<WorkspaceEntry | null>();
  /** Ids of workspaces whose folder no longer exists. */
  readonly missing = input<string[]>([]);
  /** Change count per workspace id, where known. */
  readonly counts = input<Record<string, number>>({});

  readonly select = output<string>();

  /** The trigger shows the workspace's name, not its id. */
  protected readonly nameOf = (id: unknown): string => this.workspaces().find((w) => w.id === id)?.name ?? String(id);

  protected onPick(value: unknown): void {
    if (typeof value === 'string' && value !== this.current()?.id) this.select.emit(value);
  }
}

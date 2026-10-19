import { Component, effect, input, output, signal, untracked } from '@angular/core';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmSelectImports } from '@spartan-ng/helm/select';

const ADD = '\u0000add';
const REMOVE = '\u0000remove';

/* The toolbar's workspace dropdown. Lists the known workspaces with their folder and change count, flags one
 * whose folder is gone, and ends with Add and Remove. Removing only forgets the entry.
 *
 * Built on the select primitive, used as a command picker: its value is always empty (the trigger shows the
 * current workspace as its placeholder), a pick is emitted and the value is reset, so nothing is ever "selected". */
@Component({
  selector: 'app-workspace-switcher',
  host: { class: 'contents' },
  imports: [HlmSelectImports],
  template: `
    <hlm-select [(value)]="picked">
      <hlm-select-trigger aria-label="Switch workspace">
        <hlm-select-value [placeholder]="current()?.name ?? 'No workspace'" />
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
        @if (workspaces().length > 0) {
          <hlm-select-separator />
        }
        <hlm-select-item [value]="addValue">Add workspace…</hlm-select-item>
        <hlm-select-item [value]="removeValue" [disabled]="current() === null">Remove from list…</hlm-select-item>
      </hlm-select-content>
    </hlm-select>
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
  readonly add = output<void>();
  readonly remove = output<void>();

  protected readonly addValue = ADD;
  protected readonly removeValue = REMOVE;
  protected readonly picked = signal<string | null>(null);

  constructor() {
    effect(() => {
      const value = this.picked();
      if (value === null) return;
      untracked(() => {
        if (value === ADD) this.add.emit();
        else if (value === REMOVE) this.remove.emit();
        else this.select.emit(value);
      });
      // Reset after this change-detection pass so the one select instance shows the current workspace again.
      queueMicrotask(() => this.picked.set(null));
    });
  }
}

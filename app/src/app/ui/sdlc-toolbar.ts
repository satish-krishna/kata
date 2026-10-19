import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideSettings } from '@ng-icons/lucide';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { WorkspaceSwitcher } from './workspace-switcher';

/* The AI-SDLC toolbar: seal, mode badge, workspace switcher, breadcrumb, the master repo's branch,
 * settings, and the screen's one primary action (projected). */
@Component({
  selector: 'app-sdlc-toolbar',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, WorkspaceSwitcher],
  providers: [provideIcons({ lucideChevronRight, lucideSettings })],
  template: `
    <header class="wb-toolbar">
      <div class="wb-brand">
        <span class="wb-seal">型</span>
      </div>
      <button
        hlmBtn
        variant="bare"
        size="bare"
        class="k-modebadge"
        type="button"
        title="Switch mode"
        aria-label="Switch mode"
        [disabled]="locked()"
        (click)="switchMode.emit()"
      >ai-sdlc</button>
      <div class="wb-sep"></div>
      @if (!blocked()) {
        <app-workspace-switcher
          [workspaces]="workspaces()"
          [current]="current()"
          [missing]="missing()"
          [counts]="counts()"
          (select)="select.emit($event)"
          (add)="add.emit()"
          (remove)="remove.emit()"
        />
      }
      <nav class="k-crumbs" aria-label="Breadcrumb">
        @for (crumb of crumbs(); track $index) {
          <ng-icon name="lucideChevronRight" size="14" />
          <span class="k-crumbs__item">{{ crumb }}</span>
        }
      </nav>
      @if (!blocked() && branch(); as b) {
        <span class="k-branch" data-testid="branch" title="Branch checked out in the master repo">{{ b }}</span>
      }
      <div class="wb-toolbar__spacer"></div>
      <button
        hlmBtn
        variant="bare"
        size="bare"
        class="k-iconbtn"
        type="button"
        title="Settings"
        aria-label="AI-SDLC settings"
        [disabled]="locked()"
        (click)="openSettings.emit()"
      >
        <ng-icon name="lucideSettings" size="16" />
      </button>
      <div class="wb-sep"></div>
      <ng-content />
    </header>
  `,
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
  /** A run or locked operation is in progress. */
  readonly locked = input(false);
  /** Nothing in a workspace can be acted on (the ai-sdlc plugin is missing), so the workspace controls are withheld. */
  readonly blocked = input(false);

  readonly switchMode = output<void>();
  readonly select = output<string>();
  readonly add = output<void>();
  readonly remove = output<void>();
  readonly openSettings = output<void>();
}

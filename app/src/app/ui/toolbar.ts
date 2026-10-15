import { Component, input, model, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFilePlus,
  lucideFolderOpen,
  lucideLibrary,
  lucidePackage,
  lucidePlay,
  lucideSave,
  lucideSquare,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-toolbar',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports, HlmInput, RouterLink],
  providers: [
    provideIcons({
      lucideFilePlus,
      lucideFolderOpen,
      lucideLibrary,
      lucidePackage,
      lucidePlay,
      lucideSave,
      lucideSquare,
    }),
  ],
  template: `
    <header class="wb-toolbar">
      <div class="wb-brand">
        <span class="wb-seal">型</span>
      </div>
      <div class="wb-sep"></div>
      <div class="wb-spec">
        <input hlmInput variant="bare" class="wb-specname" placeholder="spec name" aria-label="Spec name" [value]="name()" (input)="onName($event)" />
        <span class="wb-dirty" [class.wb-dirty--on]="dirty()">
          @if (dirty()) {
            <span class="wb-dirty__dot"></span>unsaved
          } @else {
            saved
          }
        </span>
      </div>
      <div class="wb-toolbar__spacer"></div>
      <div class="wb-toolbar__group">
        <button hlmBtn variant="bare" size="bare" class="k-iconbtn" type="button" title="New" aria-label="New spec" (click)="newSpec.emit()">
          <ng-icon name="lucideFilePlus" size="16" />
        </button>
        <button hlmBtn variant="bare" size="bare" class="k-iconbtn" type="button" title="Open" aria-label="Open spec" (click)="openSpec.emit()">
          <ng-icon name="lucideFolderOpen" size="16" />
        </button>
        <button hlmBtn variant="bare" size="bare" class="k-iconbtn" type="button" title="Save  Ctrl+S" aria-label="Save spec" (click)="save.emit()">
          <ng-icon name="lucideSave" size="16" />
        </button>
        <button hlmBtn variant="bare" size="bare" class="k-iconbtn" type="button" title="Export bundle" aria-label="Export bundle" (click)="exportBundle.emit()">
          <ng-icon name="lucidePackage" size="16" />
        </button>
      </div>
      <div class="wb-sep"></div>
      <a hlmBtn variant="secondary" routerLink="/library"><ng-icon name="lucideLibrary" size="14" />Library</a>
      <div class="wb-sep"></div>
      @if (running()) {
        <button hlmBtn variant="danger" type="button" (click)="cancel.emit()"><ng-icon name="lucideSquare" size="14" />Cancel</button>
      } @else {
        <button hlmBtn variant="primary" type="button" [disabled]="!canRun()" (click)="run.emit()">
          <ng-icon name="lucidePlay" size="14" />Run<span class="k-kbd">Ctrl ↵</span>
        </button>
      }
    </header>
  `,
})
export class Toolbar {
  readonly name = model.required<string>();
  readonly dirty = input.required<boolean>();
  readonly running = input(false);
  readonly canRun = input(true);
  readonly newSpec = output<void>();
  readonly openSpec = output<void>();
  readonly save = output<void>();
  readonly exportBundle = output<void>();
  readonly run = output<void>();
  readonly cancel = output<void>();

  protected onName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }
}

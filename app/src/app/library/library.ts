import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideClock,
  lucideCoins,
  lucideCpu,
  lucideFilePlus,
  lucideFolder,
  lucideFolderOpen,
  lucideGitBranch,
  lucideHash,
  lucidePackage,
  lucidePlay,
  lucideSearch,
  lucideTerminal,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { DetailActions } from '../ui/detail-actions';
import { EventRow } from '../ui/event-row';
import { MarkdownBody } from '../ui/markdown-body';
import { SummaryStat } from '../ui/summary-stat';
import { TaskEditor } from '../ui/task-editor';
import { ToolCard } from '../ui/tool-card';
import { LibraryViewModel } from './library.view-model';

@Component({
  selector: 'app-library',
  providers: [
    LibraryViewModel,
    provideIcons({
      lucideCircleCheck,
      lucideClock,
      lucideCoins,
      lucideCpu,
      lucideFilePlus,
      lucideFolder,
      lucideFolderOpen,
      lucideGitBranch,
      lucideHash,
      lucidePackage,
      lucidePlay,
      lucideSearch,
      lucideTerminal,
      lucideTriangleAlert,
    }),
  ],
  imports: [NgIcon, RouterLink, HlmButtonImports, DetailActions, EventRow, MarkdownBody, SummaryStat, TaskEditor, ToolCard],
  templateUrl: './library.html',
})
export class Library {
  protected readonly vm = inject(LibraryViewModel);

  constructor() {
    void this.vm.init();
  }
}

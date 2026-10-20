import { Component, input, output } from '@angular/core';
import type { BuildHandoff } from '../change/change-page.view-model';
import { BuildViewModel, type BuildContext } from './build-view.view-model';

@Component({
  selector: 'app-build-view',
  providers: [BuildViewModel],
  templateUrl: './build-view.html',
  styleUrl: './build-view.css',
})
export class BuildView {
  readonly handoff = input.required<BuildHandoff>();
  readonly context = input.required<BuildContext>();
  readonly closed = output<void>();
}

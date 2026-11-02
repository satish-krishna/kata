import { Component, input } from '@angular/core';
import type { RepoCheckView } from '@bindings/RepoCheckView';

/* A repository's checks as the plugin recorded them. */
@Component({
  selector: 'app-check-results',
  templateUrl: './check-results.html',
})
export class CheckResults {
  readonly views = input.required<RepoCheckView[]>();
}

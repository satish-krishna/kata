import { Component, computed, input } from '@angular/core';
import type { TaskStatus } from '@bindings/TaskStatus';
import { HlmTableImports } from '@spartan-ng/helm/table';

/* The plan tab's Build log: every task of the plan in document order with its repository, its dependencies
 * and, once it has a row in a committed build log, its commits and departure. */
@Component({
  selector: 'app-build-log-table',
  imports: [HlmTableImports],
  templateUrl: './build-log-table.html',
})
export class BuildLogTable {
  readonly tasks = input.required<TaskStatus[]>();

  protected readonly anyBuilt = computed(() => this.tasks().some((t) => t.row !== null));

  protected depends(t: TaskStatus): string {
    return t.dependsOn.length === 0 ? 'none' : t.dependsOn.join(', ');
  }
}

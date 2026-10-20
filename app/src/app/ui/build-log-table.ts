import { Component, input } from '@angular/core';
import type { TaskStatus } from '@bindings/TaskStatus';

/* The plan tab's Build log: every task of the plan in document order with its repository, its dependencies
 * and, once it has a row in a committed build log, its commits and departure. */
@Component({
  selector: 'app-build-log-table',
  templateUrl: './build-log-table.html',
})
export class BuildLogTable {
  readonly tasks = input.required<TaskStatus[]>();
}

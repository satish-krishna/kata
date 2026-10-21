import { Component, computed, input, output } from '@angular/core';
import type { TaskStatus } from '@bindings/TaskStatus';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { linkRequirements, neededBy, taskFields, taskRecord } from '../lib/plan-doc';
import { MarkdownBody } from './markdown-body';

/* The plan tab's Tasks view: the tasks in plan order on the left, the picked task in the middle (each field of its
 * plan text as a labeled section), and on the right what the build recorded for it and which tasks need it. A
 * requirement id in a field is a link; a click on one is reported, so the page can open it on the Spec tab. */
@Component({
  selector: 'app-tasks-view',
  host: { class: 'contents' },
  imports: [HlmButtonImports, MarkdownBody],
  templateUrl: './tasks-view.html',
})
export class TasksView {
  readonly tasks = input.required<TaskStatus[]>();
  /** The task shown in the middle. */
  readonly picked = input<TaskStatus | null>(null);
  readonly pick = output<string>();
  /** A requirement or scenario id (`R7`, `R7.7`) was clicked in a task's text. */
  readonly openRequirement = output<string>();

  /** Every field but Depends on, which the muted line above the name already says. The prose before the first field has no label. */
  protected readonly fields = computed(() => {
    const t = this.picked();
    return t === null ? [] : taskFields(t.text).filter((f) => f.field !== 'Depends on');
  });
  protected readonly record = computed(() => {
    const t = this.picked();
    return t === null ? null : taskRecord(t);
  });
  protected readonly needed = computed(() => {
    const t = this.picked();
    return t === null ? [] : neededBy(this.tasks(), t.id);
  });
  protected readonly link = linkRequirements;

  /** Whether the build log has a row for the task. */
  protected built(t: TaskStatus): boolean {
    return taskRecord(t).kind !== 'unbuilt';
  }

  protected dependsOn(t: TaskStatus): string {
    return t.dependsOn.length === 0 ? 'none' : t.dependsOn.join(', ');
  }

  /** Catches a click on a requirement link; the markdown body has already stopped the browser following it. */
  protected onDetailClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const href = e.target.closest('a')?.getAttribute('href') ?? '';
    if (href.startsWith('#req-')) this.openRequirement.emit(href.slice('#req-'.length));
  }
}

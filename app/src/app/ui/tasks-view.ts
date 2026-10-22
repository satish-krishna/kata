import { Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { linkRequirements, neededBy, shownSections, taskRecord, type TaskView } from '../lib/task-view';
import { MarkdownBody } from './markdown-body';
import { MarkdownInline } from './markdown-inline';

/* The plan tab's Tasks view: the tasks in plan order on the left, the picked task in the middle (each section of
 * its plan entry as a labeled block), and on the right what the build recorded for it and which tasks need it. A
 * requirement id in a field is a link; a click on one is reported, so the page can open it on the Spec tab. */
@Component({
  selector: 'app-tasks-view',
  host: { class: 'contents' },
  imports: [HlmButtonImports, MarkdownBody, MarkdownInline],
  templateUrl: './tasks-view.html',
})
export class TasksView {
  readonly tasks = input.required<TaskView[]>();
  /** The task shown in the middle. */
  readonly picked = input<TaskView | null>(null);
  readonly pick = output<string>();
  /** A requirement or scenario id (`R7`, `R7.7`) was clicked in a task's text. */
  readonly openRequirement = output<string>();

  /** Every section but Depends on, which the muted line above the name already says. The prose before the first section has no title. */
  protected readonly sections = computed(() => {
    const t = this.picked();
    return t === null ? [] : shownSections(t);
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
  protected built(t: TaskView): boolean {
    return taskRecord(t).kind !== 'unbuilt';
  }

  protected dependsOn(t: TaskView): string {
    return t.depends_on.length === 0 ? 'none' : t.depends_on.join(', ');
  }

  /** Catches a click on a requirement link; the markdown body has already stopped the browser following it. */
  protected onDetailClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const href = e.target.closest('a')?.getAttribute('href') ?? '';
    if (href.startsWith('#req-')) this.openRequirement.emit(href.slice('#req-'.length));
  }
}

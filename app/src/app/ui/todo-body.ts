import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCircle, lucideCircleDot } from '@ng-icons/lucide';
import type { Todo } from '../lib/toolcards';

@Component({
  selector: 'app-todo-body',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck, lucideCircleDot, lucideCircle })],
  template: `<ul class="k-toolcard__todo">
    @for (t of todos(); track $index) {
      <li class="k-toolcard__todo-item" [class]="'k-toolcard__todo-item--' + t.status">
        @if (t.status === 'completed') {
          <ng-icon name="lucideCheck" size="12" />
        } @else if (t.status === 'in_progress') {
          <ng-icon name="lucideCircleDot" size="12" />
        } @else {
          <ng-icon name="lucideCircle" size="12" />
        }
        <span>{{ t.content }}</span>
      </li>
    }
  </ul>`,
})
export class TodoBody {
  readonly todos = input.required<Todo[]>();
}

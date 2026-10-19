import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCircle, lucideCircleDot } from '@ng-icons/lucide';
import type { Todo } from '../lib/toolcards';

@Component({
  selector: 'app-todo-body',
  imports: [NgIcon],
  providers: [provideIcons({ lucideCheck, lucideCircleDot, lucideCircle })],
  templateUrl: './todo-body.html',
})
export class TodoBody {
  readonly todos = input.required<Todo[]>();
}

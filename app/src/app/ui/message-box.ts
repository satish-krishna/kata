import { Component, input, output } from '@angular/core';
import type { MessageBoxView } from '../lib/events';

@Component({
  selector: 'app-message-box',
  templateUrl: './message-box.html',
})
export class MessageBox {
  readonly view = input.required<MessageBoxView>();
  readonly send = output<string>();
}

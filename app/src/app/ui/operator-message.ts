import { Component, input } from '@angular/core';
import type { MessageRecord } from '../lib/events';

@Component({
  selector: 'app-operator-message',
  templateUrl: './operator-message.html',
})
export class OperatorMessage {
  readonly record = input.required<MessageRecord>();
}

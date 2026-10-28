import { Component, computed, input } from '@angular/core';
import type { MessageRecord } from '../lib/events';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock time, HH:MM:SS, of a millisecond epoch. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A message the operator sent into the run, with whether the agent has read it yet. */
@Component({
  selector: 'app-operator-message',
  templateUrl: './operator-message.html',
})
export class OperatorMessage {
  readonly record = input.required<MessageRecord>();

  protected readonly sentAt = computed(() => clock(this.record().sent_at));
  protected readonly readAt = computed(() => {
    const at = this.record().read_at;
    return at === null ? null : clock(at);
  });
}

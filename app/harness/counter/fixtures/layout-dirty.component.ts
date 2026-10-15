import { Component } from '@angular/core';

// A fixture exercising the CSS pass: a component stylesheet carrying literal
// values (a hex color and a raw px length) alongside a legitimate token. The
// template's semantic class ("card") is deliberately NOT flagged as
// presentation-on-raw: proving a semantic class is a card is Part 3's job, and
// this fixture pins that boundary.
@Component({
  selector: 'app-layout-dirty',
  template: `<div class="card">boxed</div>`,
  styles: [
    `
    .card {
      background: #3b82f6;
      padding: 16px;
      border-radius: var(--radius);
    }
  `,
  ],
})
export class LayoutDirty {}

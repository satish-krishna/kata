import { Component } from '@angular/core';

// A fixture with an inline template that carries known violations, so the
// counter's inline-template extraction path is exercised, not just .html files.
@Component({
  selector: 'app-dirty-inline',
  template: `
    <button>Inline</button>
    <input hlmInput style="color: blue" />
  `,
})
export class DirtyInline {}

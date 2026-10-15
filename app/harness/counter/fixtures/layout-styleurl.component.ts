import { Component } from '@angular/core';

// A component that references its stylesheet via styleUrl. The counter must NOT
// follow the styleUrl here (the .css is scanned standalone by the directory
// walk); following it too would double-count the same file.
@Component({
  selector: 'app-styleurl',
  template: `<div class="flex gap-2">clean template</div>`,
  styleUrl: './layout-styleurl.css',
})
export class StyleUrl {}

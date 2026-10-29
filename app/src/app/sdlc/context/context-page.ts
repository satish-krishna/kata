import { Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { DocLayout } from '../../ui/doc-layout';
import { SdlcToolbar } from '../../ui/sdlc-toolbar';
import { ContextPageViewModel } from './context-page.view-model';

@Component({
  selector: 'app-context-page',
  providers: [ContextPageViewModel],
  imports: [HlmButtonImports, SdlcToolbar, DocLayout],
  templateUrl: './context-page.html',
})
export class ContextPage {
  protected readonly vm = inject(ContextPageViewModel);
}

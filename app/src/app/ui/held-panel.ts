import { Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';

/** One repository another change holds, with the holding change and the route that opens it. */
export type HeldPanelRepo = { repo: string; holder: string; link: string[] };

/** What the held panel says: why something waits, which repositories are held and by whom, and the action to try again. */
export type HeldView = { title: string; repos: HeldPanelRepo[]; action: string };

/* The panel for a build or a review that waits for another change's repositories. Presentational: the page decides
 * when it shows; it only draws the held repositories and tells the host that the engineer asked to try again. The link
 * to the holding change is the open action, so it carries the accent; trying again is secondary. */
@Component({
  selector: 'app-held-panel',
  imports: [HlmButtonImports, RouterLink],
  templateUrl: './held-panel.html',
})
export class HeldPanel {
  readonly title = input.required<string>();
  readonly repos = input.required<HeldPanelRepo[]>();
  readonly action = input<string | null>(null);
  readonly act = output<void>();
}

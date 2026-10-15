// Capstone-residue fixture: the APP-LEVEL icon registration pattern.
// Expected tally: ZERO, at any path.
//
// This fixture exists because rule 13 was drafted wrong the first time and this
// is the case that catches it. The first draft keyed on the component decorator
// ("NgIcon in imports with no provideIcons in providers"), which reads
// plausibly and would flag every component below. But spartan's icons.md says
// an icon must be "provided to the component (or app) via provideIcons", and
// registering every glyph once in app.config.ts is a documented pattern under
// which a correct component looks exactly like this: it renders icons, it
// imports NgIcon, it imports no glyph symbol, and it registers nothing itself.
//
// Run against the capstone builds, that first draft fired 7 times on one build
// and 4 on another, and those two were the builds whose icons WORKED. A gate
// must permit everything the docs permit; this fixture is the regression guard
// that keeps rule 13 honest about the parenthesis in "(or app)".
import { Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HeroDetailViewModel } from './hero-detail.view-model';

@Component({
  selector: 'app-hero-detail',
  imports: [NgIcon],
  providers: [HeroDetailViewModel],
  template: `
    <h1>{{ vm.hero()?.name }}</h1>
    <button hlmBtn size="icon" variant="ghost"><ng-icon name="lucideTrash2" /></button>
  `,
})
export class HeroDetail {
  protected readonly vm = inject(HeroDetailViewModel);
}

@Component({
  selector: 'app-hero-badge',
  imports: [NgIcon],
  template: `<ng-icon name="lucideShieldAlert" />`,
})
export class HeroBadge {}

// Part 3 dirty fixture. Logical path in tests: src/app/ui/hero-card.ts, so the
// presentational-injects-data rule (which keys on src/app/ui/) can fire.
//
// Contrived to carry exactly one of each Part 3 kind:
//   gated (6): hand-set-change-detection, template-driven-form (FormsModule),
//              presentational-injects-data, restated-validator, component-subscribe,
//              reactive-form
//   heuristic (2): hand-written-form-model, dumb-holds-state
// So totals.all (gated only) is 6; the gate reports 6 messages on the same bytes.
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule, FormGroup, FormControl } from '@angular/forms';
import { form, required } from '@angular/forms/signals';
import { HeroService } from '../heroes/hero.service';

interface HeroModel {
  name: string;
}

@Component({
  selector: 'app-hero-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `<p>{{ draft().name }}</p>`,
})
export class HeroCard {
  private readonly heroes = inject(HeroService);
  protected readonly draft = signal<HeroModel>({ name: '' });
  protected readonly heroForm = form(this.draft, (path) => {
    required(path.name);
  });
  protected readonly reactive = new FormGroup({ name: new FormControl('') });

  ngOnInit(): void {
    this.heroes.getAll().subscribe(() => {});
  }
}

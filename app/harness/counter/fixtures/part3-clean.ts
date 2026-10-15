// Part 3 clean fixture. Logical path in tests: src/app/heroes/hero-list.ts, a
// container (not under src/app/ui/), so injecting a data service is correct and
// not flagged. Zero violations of any Part 3 kind:
//   no hand-set changeDetection, no FormsModule, no .subscribe (toSignal instead),
//   no restated validator (validation flows through the schema), and the model
//   type is imported (z.infer from the schema file), not a local interface.
import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { form, validateStandardSchema } from '@angular/forms/signals';
import { HeroService } from './hero.service';
import { heroSchema, type HeroModel } from './hero.schema';

@Component({
  selector: 'app-hero-list',
  imports: [],
  template: `<p>{{ heroes()?.length }}</p>`,
})
export class HeroList {
  private readonly service = inject(HeroService);
  protected readonly heroes = toSignal(this.service.getAll());
  protected readonly model = signal<HeroModel>({ name: '' });
  protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));
}

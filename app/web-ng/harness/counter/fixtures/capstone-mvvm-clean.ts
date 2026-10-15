// Capstone MVVM fixture: CLEAN. The shape the house doc describes.
// Expected tally: all zeros, on both engines, at a non-ui feature path.
//
// Covers deliberately: a ViewModel with a bare @Injectable() (no providedIn)
// holding every signal and the data service; a component that provides it,
// injects it, injects ActivatedRoute, and declares only component API.
import { Component, Injectable, inject, input, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HeroService } from './hero.service';

@Injectable()
export class RosterViewModel {
  private readonly heroes = inject(HeroService);
  readonly query = signal('');
  readonly filtered = computed(() => this.heroes.list().filter((h) => h.name.includes(this.query())));
}

@Component({
  selector: 'app-roster',
  providers: [RosterViewModel],
  template: `<p>{{ vm.filtered().length }}</p>`,
})
export class Roster {
  protected readonly vm = inject(RosterViewModel);
  protected readonly route = inject(ActivatedRoute);
  readonly heroId = input<number>();
}

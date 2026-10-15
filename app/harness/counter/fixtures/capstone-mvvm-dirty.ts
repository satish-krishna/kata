// Capstone MVVM fixture: DIRTY. Hand-counted against
// harness/component-shape-spec.md, rules 7 through 10, when counted with a
// NON-ui feature path (for example file: 'src/app/roster/roster.ts'):
//
//   vm-not-component-scoped (1): RosterViewModel declares providedIn
//   state-outside-vm        (2): signal() and computed() on the component
//   feature-injects-data    (2): inject(HeroService), inject(HttpClient)
//   vm-not-provided         (1): inject(RosterViewModel) with no providers entry
//
// NOT flagged on purpose: inject(ActivatedRoute) (routing is permitted in the
// component), input() (component API, not state), and the ViewModel's own
// inject(HeroService) (a ViewModel is not a @Component).
import { Component, Injectable, inject, input, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { HeroService } from './hero.service';

@Injectable({ providedIn: 'root' })
export class RosterViewModel {
  private readonly heroes = inject(HeroService);
  readonly all = computed(() => this.heroes.list());
}

@Component({
  selector: 'app-roster',
  template: `<p>{{ query() }}</p>`,
})
export class Roster {
  protected readonly vm = inject(RosterViewModel);
  private readonly heroes = inject(HeroService);
  private readonly http = inject(HttpClient);
  protected readonly route = inject(ActivatedRoute);
  readonly heroId = input<number>();
  readonly query = signal('');
  readonly filtered = computed(() => this.query().trim());
}

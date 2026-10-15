// Capstone-residue shape fixture: CLEAN. Expected: zero, at a non-ui feature
// path. Every construct the dirty fixture gets wrong, done right: no standalone
// key, NgIcon rather than NgIconsModule, provideIcons for registration, the
// subscription converted at the edge with toSignal rather than hand-managed in
// the ViewModel, and the signal-form built in the ViewModel where state lives.
import { Component, Injectable, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideUsers } from '@ng-icons/lucide';
import { form, validateStandardSchema } from '@angular/forms/signals';
import { ActivatedRoute } from '@angular/router';
import { HeroService } from './hero.service';
import { heroSchema } from './hero.schema';

@Injectable()
export class RosterViewModel {
  private readonly heroes = inject(HeroService);
  private readonly route = inject(ActivatedRoute);
  readonly params = toSignal(this.route.paramMap);
  readonly model = signal({ name: '' });
  readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));
  readonly all = this.heroes.list();
}

@Component({
  selector: 'app-roster',
  imports: [NgIcon],
  providers: [RosterViewModel, provideIcons({ lucideUsers })],
  template: `<ng-icon name="lucideUsers" /><p>{{ vm.model().name }}</p>`,
})
export class Roster {
  protected readonly vm = inject(RosterViewModel);
}

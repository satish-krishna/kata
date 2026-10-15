// Capstone-residue shape fixture: DIRTY. Rules 11 through 14 plus the two
// widenings, all drawn from drift the capstone measured getting past the full
// gate set. Hand-counted at a NON-ui feature path (for example
// file: 'src/app/roster/roster.ts'):
//
//   explicit-standalone (1): standalone: true in @Component
//   legacy-icon-module  (1): NgIconsModule in imports
//   unregistered-icon   (1): the file imports lucide glyphs and never calls
//                            provideIcons; registration is handed to an
//                            invented token instead. Rule 13 is FILE-level, so
//                            the correctly-registering control lives in the
//                            clean fixture rather than here.
//   component-subscribe (1): .subscribe in a *ViewModel  <- widening of rule 2
//   state-outside-vm    (1): heroForm = form(...) on the component. The
//                            model = signal(...) it is built from is absorbed
//                            into that one violation, not counted separately:
//                            moving the form to the ViewModel necessarily takes
//                            its backing model with it, so it is one defect.
//
// NOT flagged on purpose: the ViewModel's own inject(HeroService), because
// rule 9 fires only inside @Component classes.
//
// The orphan-ng-submit half of this residue is a TEMPLATE property and lives in
// capstone-residue-shape-dirty.html.
import { Component, Injectable, inject, signal } from '@angular/core';
import { NgIconsModule, NgIcon } from '@ng-icons/core';
import { lucideUsers, lucideTrash2 } from '@ng-icons/lucide';
import { form, validateStandardSchema } from '@angular/forms/signals';
import { ActivatedRoute } from '@angular/router';
import { HeroService } from './hero.service';
import { heroSchema } from './hero.schema';

@Injectable()
export class RosterViewModel {
  private readonly heroes = inject(HeroService);
  private readonly route = inject(ActivatedRoute);
  readonly query = signal('');
  constructor() {
    this.route.paramMap.subscribe((p) => this.query.set(p.get('q') ?? ''));
  }
}

@Component({
  selector: 'app-roster',
  standalone: true,
  imports: [NgIconsModule],
  providers: [RosterViewModel],
  template: `<p>{{ vm.query() }}</p>`,
})
export class Roster {
  protected readonly vm = inject(RosterViewModel);
  protected readonly model = signal({ name: '' });
  protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));
}

// The t3 drift, exactly: glyphs are imported and registration is handed to an
// invented token instead of provideIcons. It typechecks, registers nothing, and
// every icon renders blank.
@Component({
  selector: 'app-roster-actions',
  imports: [NgIcon],
  providers: [{ provide: 'ICONS', useValue: { lucideTrash2, lucideUsers } }],
  template: `<ng-icon name="lucideTrash2" />`,
})
export class RosterActions {}

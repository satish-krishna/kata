import { Injectable, computed, inject, signal } from '@angular/core';
import { defaultArrangement, type AreaId, type Arrangement, type LayoutMode, type Place, type Room } from '../../lib/build-layout';
import { KataTransport } from '../../core/transport/kata-transport';
import { BuildPageViewModel } from './build-page.view-model';

/** One change to the arrangement of the mode on show. */
export type ArrangeAction =
  | { kind: 'place'; area: AreaId; to: Place }
  | { kind: 'tuck'; area: AreaId }
  | { kind: 'bring-back'; area: AreaId }
  | { kind: 'resize'; side: Exclude<Place, 'middle'>; px: number }
  | { kind: 'reset' };

@Injectable()
export class BuildLayoutViewModel {
  protected readonly build = inject(BuildPageViewModel);
  protected readonly transport = inject(KataTransport);

  readonly mode = signal<LayoutMode>('overview');
  readonly focus = signal<AreaId | null>(null);
  readonly flipped = signal<Partial<Record<Place, AreaId>>>({});
  readonly suggested = signal<LayoutMode | null>(null);
  readonly handSwitched = signal(false);
  readonly room = signal<Room>({ width: 1280, height: 800 });
  readonly saved = signal<Record<LayoutMode, Arrangement | null>>({ overview: null, watch: null, changes: null, review: null });
  readonly arrangement = computed(() => this.saved()[this.mode()] ?? defaultArrangement(this.mode()));
  readonly drawn = computed(() => this.arrangement());

  open(_change: string): void {}
  pickMode(_m: LayoutMode): void {}
  arrange(_action: ArrangeAction): void {}
  focusOn(_area: AreaId): void {}
  unfocus(): void {}
  flip(_place: Place, _area: AreaId): void {}
  reveal(_area: AreaId): void {}
}

// The arrangement of the build page: which area holds the middle, which sit beside it, which are tucked away.
// Pure rules only, no Angular. Every operation returns a new arrangement and never changes its input.

export type AreaId = 'tasks' | 'activity' | 'files' | 'findings';
export type Place = 'left' | 'middle' | 'right' | 'bottom';
export type Edge = 'left' | 'right' | 'bottom';
export type LayoutMode = 'overview' | 'watch' | 'changes' | 'review';
export type Room = { width: number; height: number };

export type Arrangement = {
  middle: AreaId;
  left: AreaId[];
  right: AreaId[];
  bottom: AreaId[];
  tucked: { area: AreaId; edge: Edge; back: Exclude<Place, 'middle'> }[];
  sizes: { left: number; right: number; bottom: number };
};

export const MIN_SIDE = 160;
export const MIN_MIDDLE_WIDTH = 240;
export const MIN_ROW_HEIGHT = 280;

export function defaultArrangement(_mode: LayoutMode): Arrangement {
  throw new Error('not implemented');
}

export function place(_a: Arrangement, _area: AreaId, _to: Place): Arrangement {
  throw new Error('not implemented');
}

export function tuck(_a: Arrangement, _area: AreaId): Arrangement {
  throw new Error('not implemented');
}

export function bringBack(_a: Arrangement, _area: AreaId): Arrangement {
  throw new Error('not implemented');
}

export function resize(_a: Arrangement, _side: Exclude<Place, 'middle'>, _px: number, _room: Room): Arrangement {
  throw new Error('not implemented');
}

export function canTuck(_a: Arrangement, _area: AreaId): boolean {
  throw new Error('not implemented');
}

export function areasOnShow(_a: Arrangement, _flipped: Partial<Record<Place, AreaId>>, _focus: AreaId | null): AreaId[] {
  throw new Error('not implemented');
}

export function whereIs(_a: Arrangement, _area: AreaId): { kind: 'place'; place: Place } | { kind: 'tucked'; edge: Edge } {
  throw new Error('not implemented');
}

export function fitSizes(_a: Arrangement, _room: Room): Arrangement['sizes'] {
  throw new Error('not implemented');
}

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

type Side = Exclude<Place, 'middle'>;
const SIDES: Side[] = ['left', 'right', 'bottom'];

const tuckedAtRight = (...areas: AreaId[]): Arrangement['tucked'] => areas.map((area) => ({ area, edge: 'right', back: 'right' }));

export function defaultArrangement(mode: LayoutMode): Arrangement {
  switch (mode) {
    case 'overview':
      return { middle: 'tasks', left: [], right: ['activity'], bottom: [], tucked: tuckedAtRight('files', 'findings'), sizes: { left: 300, right: 520, bottom: 200 } };
    case 'watch':
      return { middle: 'activity', left: ['tasks'], right: [], bottom: [], tucked: tuckedAtRight('files', 'findings'), sizes: { left: 300, right: 360, bottom: 200 } };
    case 'changes':
      return { middle: 'files', left: [], right: [], bottom: ['activity'], tucked: tuckedAtRight('tasks', 'findings'), sizes: { left: 300, right: 360, bottom: 200 } };
    case 'review':
      return { middle: 'files', left: ['findings'], right: [], bottom: [], tucked: tuckedAtRight('tasks', 'activity'), sizes: { left: 380, right: 360, bottom: 200 } };
  }
}

const copy = (a: Arrangement): Arrangement => ({
  ...a,
  left: [...a.left],
  right: [...a.right],
  bottom: [...a.bottom],
  tucked: a.tucked.map((t) => ({ ...t })),
  sizes: { ...a.sizes },
});

// Takes the area out of every stack and the tucked list. The middle is left alone.
const without = (a: Arrangement, area: AreaId): Arrangement => {
  const next = copy(a);
  for (const side of SIDES) next[side] = next[side].filter((x) => x !== area);
  next.tucked = next.tucked.filter((t) => t.area !== area);
  return next;
};

// The first area of the left, then the right, then the bottom stack leaves its stack and takes the middle.
const refill = (a: Arrangement): Arrangement => {
  const next = copy(a);
  for (const side of SIDES) {
    const first = next[side].shift();
    if (first !== undefined) {
      next.middle = first;
      break;
    }
  }
  return next;
};

const inStack = (a: Arrangement, area: AreaId): Side | null => SIDES.find((side) => a[side].includes(area)) ?? null;

export function place(a: Arrangement, area: AreaId, to: Place): Arrangement {
  const from = whereIs(a, area);
  if (to === 'middle') {
    if (a.middle === area) return a;
    const next = without(a, area);
    next.right.unshift(a.middle);
    next.middle = area;
    return next;
  }
  if (from.kind === 'place' && from.place === to) return a;
  if (from.kind === 'place' && from.place === 'middle') {
    if (!canTuck(a, area)) return a;
    const next = refill(a);
    next[to].push(area);
    return next;
  }
  const next = without(a, area);
  next[to].push(area);
  return next;
}

export function canTuck(a: Arrangement, area: AreaId): boolean {
  return a.middle !== area ? true : SIDES.some((side) => a[side].length > 0);
}

export function tuck(a: Arrangement, area: AreaId): Arrangement {
  const from = whereIs(a, area);
  if (from.kind === 'tucked' || !canTuck(a, area)) return a;
  if (from.place === 'middle') {
    const next = refill(a);
    next.tucked.push({ area, edge: 'right', back: 'right' });
    return next;
  }
  const next = without(a, area);
  next.tucked.push({ area, edge: from.place, back: from.place });
  return next;
}

export function bringBack(a: Arrangement, area: AreaId): Arrangement {
  const entry = a.tucked.find((t) => t.area === area);
  if (!entry) return a;
  const next = without(a, area);
  next[entry.back].push(area);
  return next;
}

export function areasOnShow(a: Arrangement, flipped: Partial<Record<Place, AreaId>>, focus: AreaId | null): AreaId[] {
  if (focus) return [focus];
  const shown: AreaId[] = [a.middle];
  for (const side of SIDES) {
    const stack = a[side];
    if (stack.length === 0) continue;
    const flip = flipped[side];
    shown.push(flip !== undefined && stack.includes(flip) ? flip : stack[0]);
  }
  return shown;
}

export function whereIs(a: Arrangement, area: AreaId): { kind: 'place'; place: Place } | { kind: 'tucked'; edge: Edge } {
  if (a.middle === area) return { kind: 'place', place: 'middle' };
  const side = inStack(a, area);
  if (side) return { kind: 'place', place: side };
  const entry = a.tucked.find((t) => t.area === area);
  return { kind: 'tucked', edge: entry ? entry.edge : 'right' };
}

export function fitSizes(a: Arrangement, room: Room): Arrangement['sizes'] {
  const sizes = { ...a.sizes };
  const leftDrawn = a.left.length > 0;
  const rightDrawn = a.right.length > 0;
  const drawn = (side: 'left' | 'right') => (side === 'left' ? leftDrawn : rightDrawn);
  const total = () => (leftDrawn ? sizes.left : 0) + (rightDrawn ? sizes.right : 0);
  const shrink = (side: 'left' | 'right') => {
    if (!drawn(side)) return;
    const excess = total() + MIN_MIDDLE_WIDTH - room.width;
    if (excess > 0) sizes[side] = Math.max(MIN_SIDE, sizes[side] - excess);
  };
  const larger = sizes.right > sizes.left ? 'right' : 'left';
  shrink(larger);
  shrink(larger === 'left' ? 'right' : 'left');
  if (a.bottom.length > 0) sizes.bottom = Math.max(MIN_SIDE, Math.min(sizes.bottom, room.height - MIN_ROW_HEIGHT));
  return sizes;
}

export function resize(a: Arrangement, side: Side, px: number, room: Room): Arrangement {
  const fitted = fitSizes(a, room);
  let max: number;
  if (side === 'bottom') {
    max = room.height - MIN_ROW_HEIGHT;
  } else {
    const other = side === 'left' ? 'right' : 'left';
    max = room.width - MIN_MIDDLE_WIDTH - (a[other].length > 0 ? fitted[other] : 0);
  }
  const next = copy(a);
  next.sizes[side] = Math.max(MIN_SIDE, Math.min(px, max));
  return next;
}

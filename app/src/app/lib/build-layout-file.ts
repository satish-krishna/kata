// Reading and writing the remembered arrangements of the build page, one per mode.
import { MIN_SIDE, type AreaId, type Arrangement, type Edge, type LayoutMode } from './build-layout';

const MODES: LayoutMode[] = ['overview', 'watch', 'changes', 'review'];
const AREAS: AreaId[] = ['tasks', 'activity', 'files', 'findings'];
const EDGES: Edge[] = ['left', 'right', 'bottom'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArea = (v: unknown): v is AreaId => typeof v === 'string' && (AREAS as string[]).includes(v);
const isEdge = (v: unknown): v is Edge => typeof v === 'string' && (EDGES as string[]).includes(v);
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_SIDE;
const areaList = (v: unknown): AreaId[] | null => (Array.isArray(v) && v.every(isArea) ? [...v] : null);

// Returns a clean copy holding only the known fields, or null when the entry cannot be used.
function readArrangement(raw: unknown): Arrangement | null {
  if (!isRecord(raw) || !isArea(raw['middle']) || !Array.isArray(raw['tucked']) || !isRecord(raw['sizes'])) return null;
  const left = areaList(raw['left']);
  const right = areaList(raw['right']);
  const bottom = areaList(raw['bottom']);
  if (!left || !right || !bottom) return null;
  const tucked: Arrangement['tucked'] = [];
  for (const t of raw['tucked']) {
    if (!isRecord(t) || !isArea(t['area']) || !isEdge(t['edge']) || !isEdge(t['back'])) return null;
    tucked.push({ area: t['area'], edge: t['edge'], back: t['back'] });
  }
  const { left: sl, right: sr, bottom: sb } = raw['sizes'];
  if (!isSize(sl) || !isSize(sr) || !isSize(sb)) return null;
  const all = [raw['middle'], ...left, ...right, ...bottom, ...tucked.map((t) => t.area)];
  if (all.length !== AREAS.length || !AREAS.every((a) => all.includes(a))) return null;
  return { middle: raw['middle'], left, right, bottom, tucked, sizes: { left: sl, right: sr, bottom: sb } };
}

export function readLayoutFile(raw: unknown): Record<LayoutMode, Arrangement | null> {
  const modes = isRecord(raw) && raw['version'] === 1 && isRecord(raw['modes']) ? raw['modes'] : {};
  return {
    overview: readArrangement(modes['overview']),
    watch: readArrangement(modes['watch']),
    changes: readArrangement(modes['changes']),
    review: readArrangement(modes['review']),
  };
}

export function writeLayoutFile(modes: Partial<Record<LayoutMode, Arrangement>>): Record<string, unknown> {
  const out: Record<string, Arrangement> = {};
  for (const mode of MODES) {
    const a = modes[mode];
    if (a) out[mode] = a;
  }
  return { version: 1, modes: out };
}

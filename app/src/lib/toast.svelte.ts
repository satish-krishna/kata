/** Transient error notifications, rendered by Toaster (mounted in the root
 *  layout). Replaces native alert(). */
export type Toast = { id: number; kind: "error"; message: string };

const TTL_MS = 6000;
let items = $state<Toast[]>([]);
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Reactive read of the current toasts (newest last). */
export function toasts(): Toast[] {
  return items;
}

/** Push an error toast; returns its id. Auto-dismisses after TTL_MS. */
export function toastError(message: string): number {
  const id = ++seq;
  items.push({ id, kind: "error", message });
  timers.set(id, setTimeout(() => dismiss(id), TTL_MS));
  return id;
}

/** Remove a toast (and clear its timer). Unknown id is a no-op. */
export function dismiss(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  // findIndex + splice so an unknown id is a true no-op (no array
  // reassignment / spurious reactive update).
  const idx = items.findIndex((x) => x.id === id);
  if (idx !== -1) items.splice(idx, 1);
}

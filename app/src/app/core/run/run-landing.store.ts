import { Injectable, signal } from '@angular/core';
import type { OpenRun } from '@bindings/OpenRun';

/** A run the engineer picked from the running changes: the change page it belongs to opens that run's session once it has loaded. */
export type Landing = { workspaceId: string | null; system: string; change: string; run: OpenRun };

/** The folder key of a workspace as the backend names it (`RepoKey`): separators unified, `.` and repeated or trailing separators dropped, case folded (the Workbench ships on Windows only). */
export const folderKey = (folder: string): string => {
  const unified = folder.replaceAll('\\', '/');
  const joined = unified
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/');
  return (unified.startsWith('/') ? `/${joined}` : joined).toLowerCase();
};

/**
 * The hand-over between the running-changes strip and a change page: the strip says which run was picked and the page,
 * once it is on that change in that workspace, takes the request and shows the run. A request names its change, so a
 * page that is not that change leaves it alone.
 */
@Injectable({ providedIn: 'root' })
export class RunLandingStore {
  private readonly asked = signal<Landing | null>(null);

  /** The request waiting for its page, or null. */
  readonly pending = this.asked.asReadonly();

  ask(landing: Landing): void {
    this.asked.set(landing);
  }

  /** The page took the request. */
  clear(): void {
    this.asked.set(null);
  }
}

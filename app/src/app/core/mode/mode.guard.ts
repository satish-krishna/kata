import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ModeStore } from './mode.store';

/** Launch routing for the root route: no saved mode asks, a remembered AI-SDLC mode opens there, anything else is the Workbench.
 *  Only the first navigation of a session is a launch; after that the operator moves on their own. */
export const modeGuard: CanActivateFn = async () => {
  const store = inject(ModeStore);
  const router = inject(Router);
  let settings;
  try {
    settings = await store.load();
  } catch {
    // An unreadable settings file must not lock the operator out: ask, as on a first launch.
    return router.createUrlTree(['/mode']);
  }
  if (store.launched) return true;
  if (settings.mode === null) return router.createUrlTree(['/mode']);
  store.markLaunched();
  if (settings.remember && settings.mode === 'sdlc') return router.createUrlTree(['/sdlc']);
  return true;
};

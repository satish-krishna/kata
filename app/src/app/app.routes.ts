import { Routes } from '@angular/router';
import { modeGuard } from './core/mode/mode.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [modeGuard],
    loadComponent: () => import('./workbench/workbench').then((m) => m.Workbench),
  },
  { path: 'library', loadComponent: () => import('./library/library').then((m) => m.Library) },
  { path: 'sdlc', loadComponent: () => import('./sdlc/home/sdlc-home').then((m) => m.SdlcHome) },
  { path: 'mode', loadComponent: () => import('./sdlc/mode/mode-screen').then((m) => m.ModeScreen) },
];

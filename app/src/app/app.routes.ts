import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./workbench/workbench').then((m) => m.Workbench) },
  { path: 'library', loadComponent: () => import('./library/library').then((m) => m.Library) },
];

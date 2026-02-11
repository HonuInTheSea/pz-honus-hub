import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./layout/component/app.layout').then((m) => m.AppLayout),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./pages/mods/mods.page').then((m) => m.ModsPageComponent),
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard.page').then(
            (m) => m.DashboardPageComponent,
          ),
      },
      {
        path: 'documentation',
        loadComponent: () =>
          import('./pages/documentation/documentation.page').then(
            (m) => m.DocumentationPageComponent,
          ),
      },
      {
        path: 'loadouts',
        loadComponent: () =>
          import('./pages/loadouts/loadouts.page').then(
            (m) => m.LoadoutsPageComponent,
          ),
      },
      {
        path: 'collections',
        loadComponent: () =>
          import('./pages/mod-collections/mod-collections.page').then(
            (m) => m.ModCollectionsPageComponent,
          ),
      },
      {
        path: 'server',
        loadComponent: () =>
          import('./pages/server/server.page').then((m) => m.ServerPageComponent),
      },
      {
        path: 'log-inspector',
        loadComponent: () =>
          import('./pages/log-inspector/log-inspector.page').then(
            (m) => m.LogInspectorPageComponent,
          ),
      },
      {
        path: 'changelog',
        loadComponent: () =>
          import('./pages/changelog/changelog.page').then(
            (m) => m.ChangelogPageComponent,
          ),
      },
    ],
  },
];
